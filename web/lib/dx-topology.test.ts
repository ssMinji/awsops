import { describe, it, expect, vi, beforeEach } from 'vitest';

const dxSend = vi.fn();
const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-direct-connect', () => ({
  DirectConnectClient: class { constructor(public cfg: { region: string }) {} send = (cmd: unknown) => dxSend(cmd, this.cfg.region); },
  DescribeConnectionsCommand: class { constructor(public input: unknown) {} },
  DescribeVirtualInterfacesCommand: class { constructor(public input: unknown) {} },
  DescribeDirectConnectGatewaysCommand: class { constructor(public input: unknown) {} },
  DescribeDirectConnectGatewayAssociationsCommand: class { constructor(public input: unknown) {} },
  DescribeDirectConnectGatewayAttachmentsCommand: class { constructor(public input: unknown) {} },
  DescribeLagsCommand: class { constructor(public input: unknown) {} },
  DescribeLocationsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { constructor(public cfg: { region: string }) {} send = (cmd: unknown) => ec2Send(cmd, this.cfg.region); },
  DescribeVpnGatewaysCommand: class { constructor(public input: unknown) {} },
  DescribeVpnConnectionsCommand: class { constructor(public input: unknown) {} },
  DescribeCustomerGatewaysCommand: class { constructor(public input: unknown) {} },
  DescribeTransitGatewaysCommand: class { constructor(public input: unknown) {} },
  DescribeTransitGatewayAttachmentsCommand: class { constructor(public input: unknown) {} },
}));

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

beforeEach(async () => {
  dxSend.mockReset();
  ec2Send.mockReset();
  // EC2 소스 기본값: 전부 빈 응답 (테스트별로 필요한 것만 덮어씀)
  ec2Send.mockResolvedValue({});
  const { _resetDxCacheForTests } = await import('./dx-topology');
  _resetDxCacheForTests();
});

/** DX 커맨드 타입별 응답 라우터 — 리전 인자까지 전달받아 리전별 분기 테스트 가능. */
function mockDx(handlers: Record<string, (input: Record<string, unknown>, region: string) => unknown>) {
  dxSend.mockImplementation(async (cmd: Cmd, region: string) => {
    const h = handlers[cmd.constructor.name];
    if (!h) return {};
    return h(cmd.input, region);
  });
}

describe('dxTopology — discovery + merge', () => {
  it('discovers extra regions from associations and attachment VIF regions, merges deduped', async () => {
    mockDx({
      DescribeDirectConnectGatewaysCommand: () => ({
        directConnectGateways: [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'hub', amazonSideAsn: 64512, directConnectGatewayState: 'available' }],
      }),
      DescribeDirectConnectGatewayAssociationsCommand: () => ({
        directConnectGatewayAssociations: [{
          directConnectGatewayId: 'dxgw-1', associationId: 'a-1', associationState: 'associated',
          associatedGateway: { id: 'tgw-1', type: 'transitGateway', region: 'us-east-1', ownerAccount: '111' },
        }],
      }),
      DescribeDirectConnectGatewayAttachmentsCommand: () => ({
        directConnectGatewayAttachments: [{ virtualInterfaceRegion: 'ap-northeast-1' }],
      }),
      // 같은 커넥션이 두 리전 응답에 나타나도 dedupe (원본 API가 region 필드 포함 응답)
      DescribeConnectionsCommand: (_i, region) => ({
        connections: [{ connectionId: 'dxcon-1', connectionName: 'c1', connectionState: 'available', location: 'LOC1', bandwidth: '10Gbps', region: 'ap-northeast-2' },
          ...(region === 'us-east-1' ? [{ connectionId: 'dxcon-use1', connectionName: 'c2', connectionState: 'available', location: 'LOC2', bandwidth: '1Gbps', region: 'us-east-1' }] : [])],
      }),
      DescribeVirtualInterfacesCommand: () => ({ virtualInterfaces: [] }),
      DescribeLagsCommand: () => ({ lags: [] }),
      DescribeLocationsCommand: (_i, region) => ({ locations: [{ locationCode: `LOC-${region}`, locationName: region }] }),
    });

    const { dxTopology } = await import('./dx-topology');
    const t = await dxTopology();

    expect(t.regions.sort()).toEqual(['ap-northeast-1', 'ap-northeast-2', 'us-east-1']);
    expect(t.connections.map((c) => c.connectionId).sort()).toEqual(['dxcon-1', 'dxcon-use1']); // 3리전 응답에서 dedupe
    expect(t.dxGateways).toHaveLength(1);
    expect(t.dxGatewayAssociations[0].associatedGateway.id).toBe('tgw-1');
    expect(t.dxNotInUse).toBe(false);
    expect(t.available).toBe(true);
    expect(t.errors).toEqual([]);
  });

  it('infers a stub connection for hosted VIFs whose connection is not owned', async () => {
    mockDx({
      DescribeDirectConnectGatewaysCommand: () => ({ directConnectGateways: [] }),
      DescribeConnectionsCommand: () => ({ connections: [] }),
      DescribeVirtualInterfacesCommand: () => ({
        virtualInterfaces: [{
          virtualInterfaceId: 'dxvif-1', virtualInterfaceName: 'hosted-vif', virtualInterfaceType: 'transit',
          virtualInterfaceState: 'available', connectionId: 'dxcon-hosted', vlan: 100, asn: 65000,
          region: 'ap-northeast-2', location: 'LOC1',
        }],
      }),
      DescribeLagsCommand: () => ({ lags: [] }),
      DescribeLocationsCommand: () => ({ locations: [] }),
    });
    const { dxTopology } = await import('./dx-topology');
    const t = await dxTopology();
    expect(t.connections).toHaveLength(1);
    expect(t.connections[0]).toMatchObject({ connectionId: 'dxcon-hosted', isInferred: true, location: 'LOC1' });
    expect(t.dxNotInUse).toBe(false); // VIF가 있으므로 DX 사용 중
  });

  it('marks dxNotInUse when there is zero DX footprint (VPN-only estate still returned)', async () => {
    mockDx({
      DescribeDirectConnectGatewaysCommand: () => ({ directConnectGateways: [] }),
      DescribeConnectionsCommand: () => ({ connections: [] }),
      DescribeVirtualInterfacesCommand: () => ({ virtualInterfaces: [] }),
      DescribeLagsCommand: () => ({ lags: [] }),
      DescribeLocationsCommand: () => ({ locations: [] }),
    });
    ec2Send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeVpnConnectionsCommand') {
        return { VpnConnections: [{ VpnConnectionId: 'vpn-1', CustomerGatewayId: 'cgw-1', State: 'available', Type: 'ipsec.1', Category: 'VPN', VgwTelemetry: [{ OutsideIpAddress: '1.2.3.4', Status: 'UP' }, { OutsideIpAddress: '5.6.7.8', Status: 'DOWN' }] }] };
      }
      return {};
    });
    const { dxTopology } = await import('./dx-topology');
    const t = await dxTopology();
    expect(t.dxNotInUse).toBe(true);
    expect(t.available).toBe(true); // VPN 데이터는 존재
    expect(t.vpnConnections[0].tunnels).toEqual([
      { outsideIpAddress: '1.2.3.4', status: 'UP', statusMessage: undefined, acceptedRouteCount: undefined },
      { outsideIpAddress: '5.6.7.8', status: 'DOWN', statusMessage: undefined, acceptedRouteCount: undefined },
    ]);
  });

  it('discloses per-source failures without failing the whole topology', async () => {
    mockDx({
      DescribeDirectConnectGatewaysCommand: () => ({ directConnectGateways: [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'g', amazonSideAsn: 1, directConnectGatewayState: 'available' }] }),
      DescribeDirectConnectGatewayAssociationsCommand: () => ({ directConnectGatewayAssociations: [] }),
      DescribeDirectConnectGatewayAttachmentsCommand: () => ({ directConnectGatewayAttachments: [] }),
      DescribeConnectionsCommand: () => { throw new Error('AccessDenied: dx'); },
      DescribeVirtualInterfacesCommand: () => ({ virtualInterfaces: [] }),
      DescribeLagsCommand: () => ({ lags: [] }),
      DescribeLocationsCommand: () => ({ locations: [] }),
    });
    const { dxTopology } = await import('./dx-topology');
    const t = await dxTopology();
    expect(t.available).toBe(true); // DXGW는 조회됨
    expect(t.errors.some((e) => e.includes('Connections') && e.includes('AccessDenied'))).toBe(true);
  });

  it('paginates DescribeDirectConnectGateways', async () => {
    let call = 0;
    mockDx({
      DescribeDirectConnectGatewaysCommand: () => {
        call++;
        return call === 1
          ? { directConnectGateways: [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'a', amazonSideAsn: 1, directConnectGatewayState: 'available' }], nextToken: 'p2' }
          : { directConnectGateways: [{ directConnectGatewayId: 'dxgw-2', directConnectGatewayName: 'b', amazonSideAsn: 2, directConnectGatewayState: 'available' }] };
      },
      DescribeDirectConnectGatewayAssociationsCommand: () => ({ directConnectGatewayAssociations: [] }),
      DescribeDirectConnectGatewayAttachmentsCommand: () => ({ directConnectGatewayAttachments: [] }),
      DescribeConnectionsCommand: () => ({ connections: [] }),
      DescribeVirtualInterfacesCommand: () => ({ virtualInterfaces: [] }),
      DescribeLagsCommand: () => ({ lags: [] }),
      DescribeLocationsCommand: () => ({ locations: [] }),
    });
    const { dxTopology } = await import('./dx-topology');
    const t = await dxTopology();
    expect(t.dxGateways.map((g) => g.directConnectGatewayId)).toEqual(['dxgw-1', 'dxgw-2']);
  });

  it('caches: second call sends nothing new', async () => {
    mockDx({
      DescribeDirectConnectGatewaysCommand: () => ({ directConnectGateways: [] }),
      DescribeConnectionsCommand: () => ({ connections: [] }),
      DescribeVirtualInterfacesCommand: () => ({ virtualInterfaces: [] }),
      DescribeLagsCommand: () => ({ lags: [] }),
      DescribeLocationsCommand: () => ({ locations: [] }),
    });
    const { dxTopology } = await import('./dx-topology');
    await dxTopology();
    const dxCalls = dxSend.mock.calls.length;
    const ec2Calls = ec2Send.mock.calls.length;
    await dxTopology();
    expect(dxSend.mock.calls.length).toBe(dxCalls);
    expect(ec2Send.mock.calls.length).toBe(ec2Calls);
  });
});
