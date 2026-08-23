'use client';
import { useEffect, useState } from 'react';
import { Cable, GitBranch, Network, ShieldCheck } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import SegmentedControl from '@/components/ui/SegmentedControl';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { CombinedAssessment, Recommendation, ResiliencyLevel } from '@/lib/dx-engine/types/recommendations';
import { localizeDxText } from '@/lib/dx-engine/localize';

// /dx-resilience — Direct Connect 복원력 평가 (계획 W3, 이식 근거는 lib/dx-engine 헤더 참조).
// 데이터·엔진은 전부 서버(/api/dx/assessment) — 이 페이지는 평가 결과 렌더만 한다.
// "현재 상태 보기"(토폴로지/인벤토리)와 달리 목표 티어 대비 평가라 전용 페이지 (Security/
// Compliance가 인벤토리와 분리된 것과 같은 원칙). 고스트 오버레이 캔버스는 후속.

interface AssessResp {
  available: boolean;
  dxNotInUse: boolean;
  regions: string[];
  counts: { connections: number; virtualInterfaces: number; dxGateways: number; lags: number; vpnConnections: number } | null;
  target: 'high' | 'maximum';
  assessment: CombinedAssessment | null;
  errors: string[];
}

/** SLA 티어 표시 (AWS Direct Connect SLA 페이지 기준). 톤은 Badge 실존 유니온만. */
import type { BadgeTone } from '@/components/ui/Badge';
const TIER: Record<ResiliencyLevel, { label: string; sla: string; tone: BadgeTone }> = {
  none: { label: 'No Tier', sla: '—', tone: 'negative' },
  devtest: { label: 'Dev/Test', sla: 'SLA 95%', tone: 'neutral' },
  high: { label: 'High', sla: 'SLA 99.9%', tone: 'brand' },
  maximum: { label: 'Maximum', sla: 'SLA 99.99%', tone: 'positive' },
};

const SEV_TONE: Record<Recommendation['severity'], BadgeTone> = {
  critical: 'negative', warning: 'brand', info: 'neutral',
};

function TierBadge({ level }: { level: ResiliencyLevel }) {
  const t = TIER[level];
  return <Badge tone={t.tone} variant="soft">{t.label} · {t.sla}</Badge>;
}

function RecList({ recs, emptyText }: { recs: Recommendation[]; emptyText: string }) {
  const { tt, lang } = useI18n();
  if (recs.length === 0) return <div className="px-1 py-2 text-[12.5px] text-ink-400">{tt(emptyText)}</div>;
  return (
    <ul className="flex flex-col gap-2">
      {recs.map((r) => (
        <li key={r.id} className="rounded-md border border-ink-100 px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge tone={SEV_TONE[r.severity]} variant="soft">{r.severity}</Badge>
            {/* 엔진(영어 생성)은 무수정 이식 — 표시층 localizeDxText가 4언어 담당 (미매칭은 영어 통과) */}
            <span className="text-[13px] font-medium text-ink-700">{localizeDxText(r.title, lang)}</span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-ink-500">{localizeDxText(r.description, lang)}</p>
        </li>
      ))}
    </ul>
  );
}

export default function DxResiliencePage() {
  const { tt } = useI18n();
  const [target, setTarget] = useState<'high' | 'maximum'>('maximum');
  const [data, setData] = useState<AssessResp | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setErr('');
    // dev demo 모드 패스스루 (?mock=noResiliency 등) — 프로덕션 라우트에선 무시됨
    const mock = new URLSearchParams(window.location.search).get('mock');
    fetch(`/api/dx/assessment?target=${target}${mock ? `&mock=${encodeURIComponent(mock)}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: AssessResp) => { if (alive) setData(d); })
      .catch((e) => { if (alive) { setData(null); setErr(e instanceof Error ? e.message : String(e)); } });
    return () => { alive = false; };
  }, [target]);

  const a = data?.assessment ?? null;

  return (
    <>
      <PageHeader
        title="DX Resilience"
        subtitle="Direct Connect 복원력 평가 — SLA 티어 판정과 목표 티어까지의 권고 (read-only)"
        right={
          <SegmentedControl
            options={[{ value: 'high', label: 'High 목표' }, { value: 'maximum', label: 'Maximum 목표' }]}
            value={target}
            onChange={(v) => setTarget(v as 'high' | 'maximum')}
          />
        }
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{tt('DX 평가 조회 실패')}: {err}</div>}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {data && (
          <>
            {/* 상태 밴드 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile label="DX Connections" value={data.counts?.connections ?? 0} icon={<Cable size={16} />} hint={data.regions.length ? data.regions.join(', ') : undefined} />
              <StatTile label="Virtual Interfaces" value={data.counts?.virtualInterfaces ?? 0} icon={<Network size={16} />} />
              <StatTile label="DX Gateways" value={data.counts?.dxGateways ?? 0} icon={<GitBranch size={16} />} />
              <StatTile
                label={tt('종합 티어')}
                value={a ? TIER[a.resiliency.currentLevel].label : '—'}
                variant={a && (a.resiliency.currentLevel === 'maximum') ? 'accent' : a && a.resiliency.currentLevel === 'high' ? 'default' : 'warn'}
                hint={a ? TIER[a.resiliency.currentLevel].sla : undefined}
                icon={<ShieldCheck size={16} />}
              />
            </div>

            {/* 부분 실패 disclose */}
            {data.errors.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-700">
                {tt('일부 소스 조회 실패 — 결과가 불완전할 수 있습니다')}: {data.errors.slice(0, 3).join(' · ')}{data.errors.length > 3 ? ` 외 ${data.errors.length - 3}건` : ''}
              </div>
            )}

            {/* DX 미사용 온보딩 안내 */}
            {data.dxNotInUse && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-700">
                <div className="font-semibold">{tt('Direct Connect 미사용')}</div>
                <p>{tt('이 계정에서 DX 연결·VIF·게이트웨이가 발견되지 않았습니다. DX를 온보딩하면 SLA 티어 평가와 복원력 권고가 활성화됩니다.')}</p>
              </div>
            )}

            {/* DXGW별 평가 카드 */}
            {a && a.perDxGateway.length > 0 && (
              <Card title={tt('DX Gateway별 평가')} subtitle={tt('게이트웨이 단위 SLA 티어 판정 — 목표 티어까지 필요한 추가 구성이 권고로 표시됩니다')}>
                <div className="flex flex-col gap-4">
                  {a.perDxGateway.map((g) => (
                    <div key={g.dxGatewayId} className="rounded-lg border border-ink-100 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] font-semibold text-ink-700">{g.dxGatewayName || g.dxGatewayId}</span>
                        {g.isUnattached ? (
                          <Badge tone="neutral" variant="outline">{tt('미연결 — 티어 비적용')}</Badge>
                        ) : (
                          <>
                            <TierBadge level={g.currentLevel} />
                            <span className="text-[11.5px] text-ink-400">→ {tt('목표')}</span>
                            <TierBadge level={g.targetLevel} />
                          </>
                        )}
                        <span className="ml-auto text-[11.5px] text-ink-400">
                          {g.locationCount} {tt('로케이션')} · {g.connectionCount} {tt('연결')}
                        </span>
                      </div>
                      {!g.isUnattached && (
                        <div className="mt-3">
                          <RecList recs={g.recommendations} emptyText="이 게이트웨이는 목표 티어 요건을 충족합니다 — 권고 없음" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 전역 베스트 프랙티스 */}
            {a && (
              <Card title={tt('베스트 프랙티스 점검')} subtitle={tt('DX Resiliency Toolkit · Well-Architected 신뢰성 기둥 기준 — 게이트웨이에 귀속되지 않는 전역 항목 포함')}>
                <RecList
                  recs={[...a.global.bestPractice.recommendations, ...a.global.resiliency.recommendations]}
                  emptyText="전역 점검 항목 없음"
                />
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
