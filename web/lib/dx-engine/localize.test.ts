import { describe, it, expect } from 'vitest';
import { analyzeTopology } from './engine/recommendation-engine';
import { localizeDxText } from './localize';
import {
  noResiliencyTopology, devTestTopology, highResiliencyTopology,
  maximumResiliencyTopology, crossAccountTopology,
} from './utils/mock-data';
import type { Recommendation } from './types/recommendations';

const SCENARIOS = [noResiliencyTopology, devTestTopology, highResiliencyTopology, maximumResiliencyTopology, crossAccountTopology];

function allRecs(): Recommendation[] {
  const out: Recommendation[] = [];
  for (const topo of SCENARIOS) {
    for (const target of ['high', 'maximum'] as const) {
      const a = analyzeTopology(topo, target);
      out.push(...a.resiliency.recommendations, ...a.bestPractice.recommendations);
      for (const g of a.perDxGateway) out.push(...g.recommendations);
      for (const v of a.perVgw) out.push(...v.recommendations);
      if (a.publicVif) out.push(...a.publicVif.recommendations);
      if (a.lag) out.push(...a.lag.recommendations);
    }
  }
  return out;
}

describe('dx-engine localize — 커버리지 (엔진 실출력 전량 매칭)', () => {
  it('every title and description produced by the 5 scenarios localizes to Korean (no passthrough)', () => {
    const missed = new Set<string>();
    for (const r of allRecs()) {
      if (localizeDxText(r.title, 'ko') === r.title) missed.add(`[title] ${r.title}`);
      if (localizeDxText(r.description, 'ko') === r.description) missed.add(`[desc] ${r.description.slice(0, 90)}`);
    }
    expect([...missed]).toEqual([]);
  });

  it('zh and ja also cover every produced string', () => {
    for (const lang of ['zh', 'ja'] as const) {
      for (const r of allRecs()) {
        expect(localizeDxText(r.title, lang), r.title).not.toBe(r.title);
        expect(localizeDxText(r.description, lang), r.description.slice(0, 60)).not.toBe(r.description);
      }
    }
  });
});

describe('dx-engine localize — 스팟 체크', () => {
  it('en passes through unchanged', () => {
    expect(localizeDxText('Add a Second Direct Connect Location', 'en')).toBe('Add a Second Direct Connect Location');
  });
  it('unknown strings pass through (fail-open — upstream wording changes degrade to English)', () => {
    expect(localizeDxText('Some brand-new rule title', 'ko')).toBe('Some brand-new rule title');
  });
  it('interpolated params survive translation', () => {
    const ko = localizeDxText('Add Redundant Connection at AWS Direct Connect Dubai', 'ko');
    expect(ko).toBe('AWS Direct Connect Dubai에 중복 연결 추가');
    const desc = localizeDxText('BGP is down on Private-VIF-1 — no traffic can flow over this path. Check the BGP configuration, VLAN tagging, and physical connectivity.', 'ko');
    expect(desc).toContain('Private-VIF-1');
    expect(desc).toContain('BGP');
  });
  it('the composite tier-gap description translates with reuse and target variants', () => {
    const max = localizeDxText('Your topology uses only one Direct Connect location. Adding a second location with two redundant connections provides Maximum Resiliency (99.99% SLA) by eliminating both site and device failure.', 'ko');
    expect(max).toContain('Maximum Resiliency(99.99% SLA)');
    expect(max).toContain('사이트·디바이스 장애 모두');
    const reuse = localizeDxText('Your topology uses only one Direct Connect location. Reuse your existing Direct Connect location EqSG2 for this gateway provides High Resiliency (99.9% SLA) by eliminating single-site failure.', 'ko');
    expect(reuse).toContain('EqSG2');
    expect(reuse).toContain('High Resiliency(99.9% SLA)');
  });
});
