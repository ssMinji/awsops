import { describe, it, expect } from 'vitest';
import { analyzeTopology } from './engine/recommendation-engine';
import { toEngineTopology } from './adapter';
import {
  noResiliencyTopology, devTestTopology, highResiliencyTopology,
  maximumResiliencyTopology, crossAccountTopology,
} from './utils/mock-data';
import type { DxTopology } from '../dx-topology';

// 이식 검증 — Phase-0 스파이크에서 원본 엔진으로 확인한 known-answer를 "이식본"에
// 그대로 핀. 원본과 판정이 달라지면(이식 중 회귀) 여기서 잡힌다.

describe('dx-engine port — known-answer tier pins (원본 스파이크와 동일 기대값)', () => {
  it('single-location topology assesses below high', () => {
    expect(['none', 'devtest']).toContain(analyzeTopology(noResiliencyTopology, 'maximum').resiliency.currentLevel);
  });
  it('devTest topology assesses as devtest', () => {
    expect(analyzeTopology(devTestTopology, 'maximum').resiliency.currentLevel).toBe('devtest');
  });
  it('high topology assesses as high', () => {
    expect(analyzeTopology(highResiliencyTopology, 'maximum').resiliency.currentLevel).toBe('high');
  });
  it('maximum topology assesses as maximum with zero critical resiliency recs', () => {
    const a = analyzeTopology(maximumResiliencyTopology, 'maximum');
    expect(a.resiliency.currentLevel).toBe('maximum');
    expect(a.resiliency.recommendations.filter((r) => r.severity === 'critical')).toHaveLength(0);
  });
  it('crossAccount topology assesses as high', () => {
    expect(analyzeTopology(crossAccountTopology, 'maximum').resiliency.currentLevel).toBe('high');
  });
  it('single-location devtest gets the second-location recommendation', () => {
    const a = analyzeTopology(devTestTopology, 'maximum');
    expect(a.resiliency.recommendations.some((r) => /Second Direct Connect Location/i.test(r.title))).toBe(true);
  });
});

describe('dx-engine adapter — W1 DxTopology를 엔진 입력으로', () => {
  const W1_SAMPLE: DxTopology = {
    available: true, dxNotInUse: false, homeRegion: 'ap-northeast-2', regions: ['ap-northeast-2'],
    connections: [{
      connectionId: 'dxcon-1', connectionName: 'prod-1', connectionState: 'available',
      location: 'SEL1', bandwidth: '10Gbps', region: 'ap-northeast-2',
      awsLogicalDeviceId: 'dev-a',
    }],
    virtualInterfaces: [{
      virtualInterfaceId: 'dxvif-1', virtualInterfaceName: 'tvif', virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available', connectionId: 'dxcon-1', directConnectGatewayId: 'dxgw-1',
      vlan: 100, asn: 65000, bgpPeers: [{ bgpPeerId: 'p1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000 }],
      region: 'ap-northeast-2',
    }],
    dxGateways: [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'hub', amazonSideAsn: 64512, directConnectGatewayState: 'available' }],
    dxGatewayAssociations: [{
      directConnectGatewayId: 'dxgw-1', associationId: 'a1', associationState: 'associated',
      associatedGateway: { id: 'tgw-1', type: 'transitGateway', region: 'ap-northeast-2', ownerAccount: '111' },
    }],
    locations: [{ locationCode: 'SEL1', locationName: 'Seoul 1', region: 'ap-northeast-2' }],
    lags: [{ lagId: 'lag-1', lagName: 'l1', lagState: 'available', location: 'SEL1', region: 'ap-northeast-2', connectionsBandwidth: '10Gbps', numberOfConnections: 1, minimumLinks: 1, connectionIds: ['dxcon-1'] }],
    vpnGateways: [], vpnConnections: [], customerGateways: [],
    transitGateways: [{ transitGatewayId: 'tgw-1', state: 'available', ownerId: '111', amazonSideAsn: 64512 }],
    transitGatewayAttachments: [{ transitGatewayAttachmentId: 'att-1', transitGatewayId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-1', resourceOwnerId: '111', state: 'available' }],
    errors: [],
  };

  it('adapts a live W1 topology and the engine assesses it end-to-end', () => {
    const engineTopo = toEngineTopology(W1_SAMPLE);
    // LAG 멤버 역참조가 채워졌는지 (엔진 DxLag.connections는 객체 배열)
    expect(engineTopo.lags[0].connections.map((c) => c.connectionId)).toEqual(['dxcon-1']);
    const a = analyzeTopology(engineTopo, 'maximum');
    // 단일 로케이션 + 단일 연결 — high 미만 판정 + DXGW 1개 평가 카드
    expect(['none', 'devtest']).toContain(a.resiliency.currentLevel);
    expect(a.perDxGateway).toHaveLength(1);
    expect(a.perDxGateway[0].currentLevel).not.toBe('high');
    expect(a.dxNotInUse).toBe(false);
  });

  it('zero-DX estate flows through as dxNotInUse', () => {
    const empty: DxTopology = {
      ...W1_SAMPLE,
      connections: [], virtualInterfaces: [], dxGateways: [], dxGatewayAssociations: [],
      lags: [], locations: [], transitGateways: [], transitGatewayAttachments: [],
      dxNotInUse: true,
    };
    const a = analyzeTopology(toEngineTopology(empty), 'high');
    expect(a.dxNotInUse).toBe(true);
    expect(a.perDxGateway).toHaveLength(0);
  });
});
