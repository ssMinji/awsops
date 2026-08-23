// lib/dx-topology.ts(서버측 발견, W1 스코프)의 결과를 이식 엔진의 TopologyData로 변환.
// W1이 의도적으로 수집하지 않는 필드(VPC 목록·피어링·Cloud WAN·라우트 테이블·태그·BGP peer
// 주소 등)는 빈 값으로 채운다 — 엔진의 해당 룰은 자연스럽게 no-op. 수집 범위를 넓히면
// 여기만 좁히면 된다. 티어 판정·권고의 핵심 입력(연결/VIF/LAG/DXGW/VGW/VPN/CGW/TGW)은
// 전부 실데이터로 전달된다.
import type { DxTopology } from '../dx-topology';
import type { TopologyData } from './types/topology';
import type { DxConnection as EngineDxConnection } from './types/aws-resources';

export function toEngineTopology(t: DxTopology): TopologyData {
  // 엔진 DxLag.connections는 멤버 연결 객체를 요구 — connectionIds로 역참조해 채운다.
  const connById = new Map(t.connections.map((c) => [c.connectionId, c]));
  const engineConnections: EngineDxConnection[] = t.connections.map((c) => ({ ...c, hasBfd: false }));
  const engineConnById = new Map(engineConnections.map((c) => [c.connectionId, c]));

  return {
    connections: engineConnections,
    virtualInterfaces: t.virtualInterfaces.map((v) => ({
      ...v,
      bgpPeers: v.bgpPeers.map((p) => ({ ...p, customerAddress: '', amazonAddress: '' })),
    })),
    dxGateways: t.dxGateways,
    dxGatewayAssociations: t.dxGatewayAssociations.map((a) => ({
      ...a,
      associatedGateway: { ...a.associatedGateway, type: a.associatedGateway.type },
      allowedPrefixes: [],
    })),
    locations: t.locations.map((l) => ({ ...l, availablePortSpeeds: [] })),
    lags: t.lags.map((l) => ({
      ...l,
      connections: l.connectionIds
        .map((id) => engineConnById.get(id) ?? (connById.get(id) && { ...connById.get(id)!, hasBfd: false }))
        .filter((c): c is EngineDxConnection => c != null),
    })),
    vpcs: [],
    vpnGateways: t.vpnGateways.map((g) => ({ ...g, tags: {} })),
    vpnConnections: t.vpnConnections.map((v) => ({ ...v, customerGatewayAddress: '', tags: {} })),
    customerGateways: t.customerGateways.map((c) => ({ ...c, tags: {} })),
    transitGateways: t.transitGateways.map((g) => ({
      ...g, transitGatewayArn: '', description: g.description ?? '', tags: {},
    })),
    transitGatewayAttachments: t.transitGatewayAttachments.map((a) => ({
      ...a,
      resourceType: (['vpc', 'vpn', 'direct-connect-gateway', 'peering', 'connect', 'network-function'].includes(a.resourceType)
        ? a.resourceType
        : 'vpc') as TopologyData['transitGatewayAttachments'][number]['resourceType'],
    })),
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map(),
    vpcRouteTables: new Map(),
    cloudWanRoutes: new Map(),
  };
}
