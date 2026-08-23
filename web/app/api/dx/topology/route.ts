import { verifyUser } from '@/lib/auth';
import { dxTopology } from '@/lib/dx-topology';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 멀티 리전 발견 팬아웃 (첫 콜드 조회 수 초~수십 초)

// Direct Connect 토폴로지 — 단일 계정 발견 결과 (lib/dx-topology.ts, TTL 4분 캐시).
// nfm 라우트 계약 미러: 발견 실패는 200 + available:false로 degrade (페이지가 정직 안내),
// 401만 인증 실패. W2(토폴로지/인벤토리 흡수)·W3(/dx-resilience 평가)이 공유 소비.

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const topology = await dxTopology();
    return Response.json(topology);
  } catch (e) {
    return Response.json({
      available: false, dxNotInUse: true, regions: [],
      connections: [], virtualInterfaces: [], dxGateways: [], dxGatewayAssociations: [],
      locations: [], lags: [], vpnGateways: [], vpnConnections: [], customerGateways: [],
      transitGateways: [], transitGatewayAttachments: [],
      errors: [e instanceof Error ? e.message : String(e)],
    });
  }
}
