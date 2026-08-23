import {
  DirectConnectClient,
  DescribeConnectionsCommand,
  DescribeVirtualInterfacesCommand,
  DescribeDirectConnectGatewaysCommand,
  DescribeDirectConnectGatewayAssociationsCommand,
  DescribeDirectConnectGatewayAttachmentsCommand,
  DescribeLagsCommand,
  DescribeLocationsCommand,
} from '@aws-sdk/client-direct-connect';
import {
  EC2Client,
  DescribeVpnGatewaysCommand,
  DescribeVpnConnectionsCommand,
  DescribeCustomerGatewaysCommand,
  DescribeTransitGatewaysCommand,
  DescribeTransitGatewayAttachmentsCommand,
} from '@aws-sdk/client-ec2';

// Direct Connect 토폴로지 발견 — aws-samples/sample-network-resilience-agent(MIT-0)의
// fetch-topology.ts 5-phase 알고리즘을 서버측(BFF)으로 이식 (원본은 브라우저 직접 호출).
// W1 스코프 = 단일 계정 + DX 중심 리소스만: 계획 docs/plans/2026-08-22-dx-resilience-plan.md.
//   Phase 1  DXGW(글로벌) → Phase 2  DXGW별 associations/attachments(리전 단서)
//   → Phase 3  리전별 병렬(DX conn/VIF/LAG/location + EC2 VGW/VPN/CGW/TGW/TGW-att)
//   → Phase 4  ID 기준 dedupe 병합 + hosted-VIF 유추 연결.
// 원본 대비 의도적 제외(후속): Cloud WAN(networkmanager) · 전체 리전 sweep(DescribeRegions
// — DX 단서 기반 발견으로 충분, 계정 전역 VPN-only 추적은 W2 이후) · 스포크 계정 enrich ·
// SSM 리전명 · CloudWatch/Health 부가 신호 · cross-account 협회 proposal backfill.
// 패턴은 lib/nfm.ts와 동일: TTL 4분 캐시 + in-flight dedupe, 소스별 실패는 errors로
// disclose(부분 실패가 전체를 죽이지 않음), DX 부재는 dxNotInUse로 정직 표시.

const HOME_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const dxClients = new Map<string, DirectConnectClient>();
const ec2Clients = new Map<string, EC2Client>();
const dx = (region: string) => {
  let c = dxClients.get(region);
  if (!c) { c = new DirectConnectClient({ region }); dxClients.set(region, c); }
  return c;
};
const ec2 = (region: string) => {
  let c = ec2Clients.get(region);
  if (!c) { c = new EC2Client({ region }); ec2Clients.set(region, c); }
  return c;
};

// ── Types — 원본 TopologyData의 필드명을 그대로 미러 (W3 엔진 이식이 무변환 소비) ──

export interface DxBgpPeer { bgpPeerId: string; bgpPeerState: string; bgpStatus: string; asn: number }
export interface DxConnection {
  connectionId: string; connectionName: string; connectionState: string;
  location: string; bandwidth: string; region: string;
  lagId?: string; partnerName?: string; vlan?: number;
  awsDeviceV2?: string; awsLogicalDeviceId?: string;
  /** hosted VIF에서 유추된 스텁 (DescribeConnections 미반환 — 타계정 소유 hosted 연결). */
  isInferred?: boolean;
}
export interface DxVirtualInterface {
  virtualInterfaceId: string; virtualInterfaceName: string;
  virtualInterfaceType: 'private' | 'public' | 'transit';
  virtualInterfaceState: string; connectionId: string;
  directConnectGatewayId?: string; virtualGatewayId?: string;
  vlan: number; asn: number; bgpPeers: DxBgpPeer[];
  region: string; location?: string; ownerAccount?: string;
  awsDeviceV2?: string; awsLogicalDeviceId?: string;
}
export interface DxGateway {
  directConnectGatewayId: string; directConnectGatewayName: string;
  amazonSideAsn: number; directConnectGatewayState: string;
}
export interface DxGatewayAssociation {
  directConnectGatewayId: string; associationId?: string; associationState: string;
  associatedGateway: { id: string; type?: 'virtualPrivateGateway' | 'transitGateway'; region: string; ownerAccount: string };
}
export interface DxLocation { locationCode: string; locationName: string; region: string }
export interface DxLag {
  lagId: string; lagName: string; lagState: string; location: string; region: string;
  connectionsBandwidth: string; numberOfConnections: number; minimumLinks: number;
  connectionIds: string[];
}
export interface VpnGateway {
  vpnGatewayId: string; state: string; type: string; amazonSideAsn: number;
  vpcAttachments: { vpcId: string; state: string }[];
}
export interface VpnTunnel { outsideIpAddress: string; status: 'UP' | 'DOWN'; statusMessage?: string; acceptedRouteCount?: number }
export interface VpnConnection {
  vpnConnectionId: string; vpnGatewayId?: string; transitGatewayId?: string;
  customerGatewayId: string; state: string; type: string; category: string;
  tunnels: VpnTunnel[];
}
export interface CustomerGateway { customerGatewayId: string; bgpAsn: string; ipAddress: string; state: string; type: string }
export interface TransitGateway { transitGatewayId: string; state: string; ownerId: string; amazonSideAsn: number; description?: string }
export interface TransitGatewayAttachment {
  transitGatewayAttachmentId: string; transitGatewayId: string;
  resourceType: string; resourceId: string; resourceOwnerId: string; state: string;
}

export interface DxTopology {
  /** 어떤 소스든 데이터가 있으면 true — 전 소스 실패 시 false. */
  available: boolean;
  /** DX 발자국 0 (connection/VIF/DXGW 전무) — 티어 평가 비적용 신호. */
  dxNotInUse: boolean;
  homeRegion: string;
  /** 발견되어 조회한 리전 전체 (home 포함). */
  regions: string[];
  connections: DxConnection[];
  virtualInterfaces: DxVirtualInterface[];
  dxGateways: DxGateway[];
  dxGatewayAssociations: DxGatewayAssociation[];
  locations: DxLocation[];
  lags: DxLag[];
  vpnGateways: VpnGateway[];
  vpnConnections: VpnConnection[];
  customerGateways: CustomerGateway[];
  transitGateways: TransitGateway[];
  transitGatewayAttachments: TransitGatewayAttachment[];
  /** 소스별 실패 disclose — "source: message". 부분 실패는 여기로만 드러난다. */
  errors: string[];
}

// ── TTL cache + in-flight dedupe (nfm.ts 패턴) ──────────────────────────────
const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetDxCacheForTests() {
  cache.clear(); inflight.clear(); dxClients.clear(); ec2Clients.clear();
}

/** 소스별 fail-open 래퍼 — 실패는 errors에 disclose하고 []로 degrade. */
function logged<T>(name: string, p: Promise<T[]>, errors: string[]): Promise<T[]> {
  return p.catch((e) => {
    errors.push(`${name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    return [] as T[];
  });
}

// ── Fetchers (원본 direct-connect.ts / ec2.ts 매핑 미러 — 페이지네이션 포함) ──

async function fetchDxGateways(region: string): Promise<DxGateway[]> {
  const out: DxGateway[] = [];
  let nextToken: string | undefined;
  do {
    const res = await dx(region).send(new DescribeDirectConnectGatewaysCommand({ nextToken }));
    for (const g of res.directConnectGateways ?? []) {
      out.push({
        directConnectGatewayId: g.directConnectGatewayId ?? '',
        directConnectGatewayName: g.directConnectGatewayName ?? '',
        amazonSideAsn: Number(g.amazonSideAsn ?? 0),
        directConnectGatewayState: g.directConnectGatewayState ?? '',
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

async function fetchAssociations(region: string, gatewayId: string): Promise<DxGatewayAssociation[]> {
  const out: DxGatewayAssociation[] = [];
  let nextToken: string | undefined;
  do {
    const res = await dx(region).send(new DescribeDirectConnectGatewayAssociationsCommand({ directConnectGatewayId: gatewayId, nextToken }));
    for (const a of res.directConnectGatewayAssociations ?? []) {
      out.push({
        directConnectGatewayId: a.directConnectGatewayId ?? '',
        associationId: a.associationId,
        associationState: a.associationState ?? '',
        associatedGateway: {
          id: a.associatedGateway?.id ?? '',
          type: a.associatedGateway?.type as DxGatewayAssociation['associatedGateway']['type'],
          region: a.associatedGateway?.region ?? '',
          ownerAccount: a.associatedGateway?.ownerAccount ?? '',
        },
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** DXGW attachments의 virtualInterfaceRegion — 리전 API가 못 드러내는 DX 리전 발견용. */
async function fetchAttachmentRegions(region: string, gatewayId: string): Promise<string[]> {
  const out = new Set<string>();
  let nextToken: string | undefined;
  do {
    const res = await dx(region).send(new DescribeDirectConnectGatewayAttachmentsCommand({ directConnectGatewayId: gatewayId, nextToken }));
    for (const a of res.directConnectGatewayAttachments ?? []) {
      if (a.virtualInterfaceRegion) out.add(a.virtualInterfaceRegion);
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return [...out];
}

async function fetchConnections(region: string): Promise<DxConnection[]> {
  const res = await dx(region).send(new DescribeConnectionsCommand({}));
  return (res.connections ?? []).map((c) => ({
    connectionId: c.connectionId ?? '', connectionName: c.connectionName ?? '',
    connectionState: c.connectionState ?? '', location: c.location ?? '',
    bandwidth: c.bandwidth ?? '', region: c.region ?? region,
    lagId: c.lagId, partnerName: c.partnerName, vlan: c.vlan,
    awsDeviceV2: c.awsDeviceV2, awsLogicalDeviceId: c.awsLogicalDeviceId,
  }));
}

async function fetchVifs(region: string): Promise<DxVirtualInterface[]> {
  const res = await dx(region).send(new DescribeVirtualInterfacesCommand({}));
  return (res.virtualInterfaces ?? []).map((v) => ({
    virtualInterfaceId: v.virtualInterfaceId ?? '', virtualInterfaceName: v.virtualInterfaceName ?? '',
    virtualInterfaceType: (v.virtualInterfaceType ?? 'private') as DxVirtualInterface['virtualInterfaceType'],
    virtualInterfaceState: v.virtualInterfaceState ?? '', connectionId: v.connectionId ?? '',
    directConnectGatewayId: v.directConnectGatewayId, virtualGatewayId: v.virtualGatewayId,
    vlan: v.vlan ?? 0, asn: v.asn ?? 0,
    bgpPeers: (v.bgpPeers ?? []).map((p) => ({
      bgpPeerId: p.bgpPeerId ?? '', bgpPeerState: p.bgpPeerState ?? '',
      bgpStatus: p.bgpStatus ?? '', asn: p.asn ?? 0,
    })),
    region: v.region ?? region, location: v.location, ownerAccount: v.ownerAccount,
    awsDeviceV2: v.awsDeviceV2, awsLogicalDeviceId: v.awsLogicalDeviceId,
  }));
}

async function fetchLags(region: string): Promise<DxLag[]> {
  const res = await dx(region).send(new DescribeLagsCommand({}));
  return (res.lags ?? []).map((l) => ({
    lagId: l.lagId ?? '', lagName: l.lagName ?? '', lagState: l.lagState ?? '',
    location: l.location ?? '', region: l.region ?? region,
    connectionsBandwidth: l.connectionsBandwidth ?? '',
    numberOfConnections: l.numberOfConnections ?? 0, minimumLinks: l.minimumLinks ?? 0,
    connectionIds: (l.connections ?? []).map((c) => c.connectionId ?? '').filter(Boolean),
  }));
}

async function fetchLocations(region: string): Promise<DxLocation[]> {
  const res = await dx(region).send(new DescribeLocationsCommand({}));
  return (res.locations ?? []).map((l) => ({
    locationCode: l.locationCode ?? '', locationName: l.locationName ?? '', region,
  }));
}

async function fetchVpnGateways(region: string): Promise<VpnGateway[]> {
  const res = await ec2(region).send(new DescribeVpnGatewaysCommand({ Filters: [{ Name: 'state', Values: ['available'] }] }));
  return (res.VpnGateways ?? []).map((g) => ({
    vpnGatewayId: g.VpnGatewayId ?? '', state: g.State ?? '', type: g.Type ?? '',
    amazonSideAsn: Number(g.AmazonSideAsn ?? 0),
    vpcAttachments: (g.VpcAttachments ?? []).map((a) => ({ vpcId: a.VpcId ?? '', state: a.State ?? '' })),
  }));
}

async function fetchVpnConnections(region: string): Promise<VpnConnection[]> {
  const res = await ec2(region).send(new DescribeVpnConnectionsCommand({}));
  return (res.VpnConnections ?? []).map((v) => ({
    vpnConnectionId: v.VpnConnectionId ?? '', vpnGatewayId: v.VpnGatewayId,
    transitGatewayId: v.TransitGatewayId, customerGatewayId: v.CustomerGatewayId ?? '',
    state: v.State ?? '', type: v.Type ?? '', category: v.Category ?? '',
    tunnels: (v.VgwTelemetry ?? []).map((t) => ({
      outsideIpAddress: t.OutsideIpAddress ?? '',
      status: (t.Status === 'UP' ? 'UP' : 'DOWN') as VpnTunnel['status'],
      statusMessage: t.StatusMessage, acceptedRouteCount: t.AcceptedRouteCount,
    })),
  }));
}

async function fetchCustomerGateways(region: string): Promise<CustomerGateway[]> {
  const res = await ec2(region).send(new DescribeCustomerGatewaysCommand({}));
  return (res.CustomerGateways ?? []).map((c) => ({
    customerGatewayId: c.CustomerGatewayId ?? '', bgpAsn: c.BgpAsn ?? '',
    ipAddress: c.IpAddress ?? '', state: c.State ?? '', type: c.Type ?? '',
  }));
}

async function fetchTransitGateways(region: string): Promise<TransitGateway[]> {
  const res = await ec2(region).send(new DescribeTransitGatewaysCommand({}));
  return (res.TransitGateways ?? []).map((t) => ({
    transitGatewayId: t.TransitGatewayId ?? '', state: t.State ?? '',
    ownerId: t.OwnerId ?? '', description: t.Description,
    amazonSideAsn: Number(t.Options?.AmazonSideAsn ?? 0),
  }));
}

async function fetchTgwAttachments(region: string): Promise<TransitGatewayAttachment[]> {
  const res = await ec2(region).send(new DescribeTransitGatewayAttachmentsCommand({}));
  return (res.TransitGatewayAttachments ?? []).map((a) => ({
    transitGatewayAttachmentId: a.TransitGatewayAttachmentId ?? '',
    transitGatewayId: a.TransitGatewayId ?? '',
    resourceType: a.ResourceType ?? 'vpc', resourceId: a.ResourceId ?? '',
    resourceOwnerId: a.ResourceOwnerId ?? '', state: a.State ?? '',
  }));
}

// ── Discovery (5-phase, 단일 계정) ──────────────────────────────────────────

interface RegionSlice {
  region: string;
  conns: DxConnection[]; vifs: DxVirtualInterface[]; lags: DxLag[]; locs: DxLocation[];
  vgws: VpnGateway[]; vpns: VpnConnection[]; cgws: CustomerGateway[];
  tgws: TransitGateway[]; tgwAtts: TransitGatewayAttachment[];
}

async function fetchRegionSlice(region: string, errors: string[]): Promise<RegionSlice> {
  const [conns, vifs, lags, locs, vgws, vpns, cgws, tgws, tgwAtts] = await Promise.all([
    logged(`${region}/Connections`, fetchConnections(region), errors),
    logged(`${region}/VirtualInterfaces`, fetchVifs(region), errors),
    logged(`${region}/Lags`, fetchLags(region), errors),
    logged(`${region}/Locations`, fetchLocations(region), errors),
    logged(`${region}/VpnGateways`, fetchVpnGateways(region), errors),
    logged(`${region}/VpnConnections`, fetchVpnConnections(region), errors),
    logged(`${region}/CustomerGateways`, fetchCustomerGateways(region), errors),
    logged(`${region}/TransitGateways`, fetchTransitGateways(region), errors),
    logged(`${region}/TGWAttachments`, fetchTgwAttachments(region), errors),
  ]);
  return { region, conns, vifs, lags, locs, vgws, vpns, cgws, tgws, tgwAtts };
}

function dedupeInto<T>(seen: Set<string>, out: T[], items: T[], key: (t: T) => string) {
  for (const it of items) {
    const k = key(it);
    if (k && !seen.has(k)) { seen.add(k); out.push(it); }
  }
}

/** 단일 계정 DX 토폴로지 발견 — TTL 캐시 (홈 리전 키). */
export async function dxTopology(): Promise<DxTopology> {
  return cached(`topo|${HOME_REGION}`, async () => {
    const errors: string[] = [];

    // Phase 1 — DXGW는 글로벌 (홈 리전 클라이언트로 조회)
    const dxGateways = await logged('DxGateways', fetchDxGateways(HOME_REGION), errors);

    // Phase 2 — DXGW별 associations + attachment 리전 (병렬) + 홈 리전 슬라이스 동시 시작
    const [assocGroups, attachmentRegionGroups, homeSlice] = await Promise.all([
      Promise.all(dxGateways.map((g) => logged(`DxGwAssoc(${g.directConnectGatewayId})`, fetchAssociations(HOME_REGION, g.directConnectGatewayId), errors))),
      Promise.all(dxGateways.map((g) => logged(`DxGwAttachRegions(${g.directConnectGatewayId})`, fetchAttachmentRegions(HOME_REGION, g.directConnectGatewayId), errors))),
      fetchRegionSlice(HOME_REGION, errors),
    ]);
    const dxGatewayAssociations = assocGroups.flat();

    // Phase 3 — 추가 리전 발견: association 리전 + attachment VIF 리전
    const extraRegions = new Set<string>();
    for (const a of dxGatewayAssociations) if (a.associatedGateway.region) extraRegions.add(a.associatedGateway.region);
    for (const rs of attachmentRegionGroups) for (const r of rs) extraRegions.add(r);
    extraRegions.delete(HOME_REGION);
    const extraSlices = await Promise.all([...extraRegions].map((r) => fetchRegionSlice(r, errors)));

    // Phase 4 — dedupe 병합
    const slices = [homeSlice, ...extraSlices];
    const t: DxTopology = {
      available: false, dxNotInUse: false, homeRegion: HOME_REGION,
      regions: [HOME_REGION, ...extraRegions],
      connections: [], virtualInterfaces: [], dxGateways, dxGatewayAssociations,
      locations: [], lags: [], vpnGateways: [], vpnConnections: [], customerGateways: [],
      transitGateways: [], transitGatewayAttachments: [], errors,
    };
    const seen = {
      conn: new Set<string>(), vif: new Set<string>(), lag: new Set<string>(), loc: new Set<string>(),
      vgw: new Set<string>(), vpn: new Set<string>(), cgw: new Set<string>(),
      tgw: new Set<string>(), tgwAtt: new Set<string>(),
    };
    for (const s of slices) {
      dedupeInto(seen.conn, t.connections, s.conns, (x) => x.connectionId);
      dedupeInto(seen.vif, t.virtualInterfaces, s.vifs, (x) => x.virtualInterfaceId);
      dedupeInto(seen.lag, t.lags, s.lags, (x) => x.lagId);
      dedupeInto(seen.loc, t.locations, s.locs, (x) => x.locationCode);
      dedupeInto(seen.vgw, t.vpnGateways, s.vgws, (x) => x.vpnGatewayId);
      dedupeInto(seen.vpn, t.vpnConnections, s.vpns, (x) => x.vpnConnectionId);
      dedupeInto(seen.cgw, t.customerGateways, s.cgws, (x) => x.customerGatewayId);
      dedupeInto(seen.tgw, t.transitGateways, s.tgws, (x) => x.transitGatewayId);
      dedupeInto(seen.tgwAtt, t.transitGatewayAttachments, s.tgwAtts, (x) => x.transitGatewayAttachmentId);
    }

    // hosted-VIF 유추 연결 (원본 로직 이식): VIF가 참조하는 connectionId가 소유
    // 연결 목록에 없으면(타계정 소유 hosted 연결) 스텁을 만들어 경로가 끊기지 않게 한다.
    for (const vif of t.virtualInterfaces) {
      if (!vif.connectionId || seen.conn.has(vif.connectionId)) continue;
      seen.conn.add(vif.connectionId);
      t.connections.push({
        connectionId: vif.connectionId,
        connectionName: vif.virtualInterfaceName || `Hosted Connection (${vif.connectionId})`,
        connectionState: 'available', location: vif.location ?? '', bandwidth: '',
        region: vif.region, awsDeviceV2: vif.awsDeviceV2, awsLogicalDeviceId: vif.awsLogicalDeviceId,
        isInferred: true,
      });
    }

    t.dxNotInUse = t.connections.length === 0 && t.virtualInterfaces.length === 0 && t.dxGateways.length === 0;
    // available: 뭐라도 성공적으로 조회됨 (전 소스 실패 = 호출 수만큼 에러 + 데이터 0 → false).
    const totalItems = t.connections.length + t.virtualInterfaces.length + t.dxGateways.length
      + t.vpnConnections.length + t.transitGateways.length + t.customerGateways.length;
    t.available = totalItems > 0 || errors.length === 0;
    return t;
  });
}
