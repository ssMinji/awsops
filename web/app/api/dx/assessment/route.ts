import { verifyUser } from '@/lib/auth';
import { dxTopology } from '@/lib/dx-topology';
import { toEngineTopology } from '@/lib/dx-engine/adapter';
import { analyzeTopology } from '@/lib/dx-engine/engine/recommendation-engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// DX 복원력 평가 — 발견(캐시된 dxTopology) + 이식 엔진(analyzeTopology)을 서버에서
// 결합해 평가 결과만 반환한다. 엔진(~5.6k LOC)을 클라이언트 번들에 싣지 않기 위한
// 서버측 실행 — 타깃 티어 변경은 이 라우트 재호출(토폴로지는 TTL 캐시라 ms 단위).

const TARGETS = new Set(['high', 'maximum']);

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const targetRaw = url.searchParams.get('target') ?? 'maximum';
  const target = (TARGETS.has(targetRaw) ? targetRaw : 'maximum') as 'high' | 'maximum';

  // dev 전용 demo 모드 (원본 샘플의 'Use demo data' 대응) — 알려진 시나리오 5종으로
  // UI를 실데이터 없이 확인한다. 프로덕션 빌드(NODE_ENV=production)에선 무시.
  const mock = url.searchParams.get('mock');
  if (mock && process.env.NODE_ENV !== 'production') {
    const { getMockTopology } = await import('@/lib/dx-engine/utils/mock-data');
    const topo = getMockTopology(mock as Parameters<typeof getMockTopology>[0]);
    return Response.json({
      available: true,
      dxNotInUse: topo.connections.length === 0 && topo.virtualInterfaces.length === 0 && topo.dxGateways.length === 0,
      regions: [...new Set(topo.connections.map((c) => c.region))],
      counts: {
        connections: topo.connections.length, virtualInterfaces: topo.virtualInterfaces.length,
        dxGateways: topo.dxGateways.length, lags: topo.lags.length, vpnConnections: topo.vpnConnections.length,
      },
      target, assessment: analyzeTopology(topo, target), errors: [], demo: mock,
    });
  }

  try {
    const topology = await dxTopology();
    const assessment = analyzeTopology(toEngineTopology(topology), target);
    return Response.json({
      available: topology.available,
      dxNotInUse: topology.dxNotInUse,
      regions: topology.regions,
      counts: {
        connections: topology.connections.length,
        virtualInterfaces: topology.virtualInterfaces.length,
        dxGateways: topology.dxGateways.length,
        lags: topology.lags.length,
        vpnConnections: topology.vpnConnections.length,
      },
      target,
      assessment,
      errors: topology.errors,
    });
  } catch (e) {
    // 발견/평가 실패 — 페이지가 정직 안내를 그리도록 200 degrade (nfm 계약).
    return Response.json({
      available: false, dxNotInUse: true, regions: [], counts: null, target,
      assessment: null, errors: [e instanceof Error ? e.message : String(e)],
    });
  }
}
