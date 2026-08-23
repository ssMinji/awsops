# Plan — Direct Connect 복원력 (DX Resilience) — 3갈래 통합

> 원천 / Source: [aws-samples/sample-network-resilience-agent](https://github.com/aws-samples/sample-network-resilience-agent) (MIT-0) — DX 토폴로지 자동 발견(5-phase) + SLA 티어 평가 + 권고 고스트 오버레이 + 토폴로지 컨텍스트 챗.
> **차용 범위 = 백엔드 로직만.** 샘플은 브라우저가 AWS API를 직접 호출하는 credential-in-browser SPA(React 19/Vite/Tailwind4)인데, 우리는 ① 자격 모델 = awsops 기준(**web task role, 서버측 호출** — 브라우저 자격 입력 없음) ② UI = awsops 기준(Next 14 / React 18 / Tailwind 3 / 기존 `@xyflow/react` 12 컴포넌트 관례)으로 전면 개편한다. 이식 가치가 있는 것은 순수 로직 3종: `fetch-topology.ts`의 5-phase 발견 알고리즘, SLA 티어 판정 엔진, 권고 룰(문서 근거: DX Resiliency Toolkit / WA Reliability Pillar).
> 현황 대조: awsops에는 DX 관련 기능이 **0건** (인벤토리 타입·라이브 lib·MCP 도구·그래프 카탈로그·API 전부 부재) — 겹침 없이 순수 신규 커버리지. 기존 네트워크 메뉴는 VPC 안쪽만 다루고, 온프레미스↔AWS 경계는 공백.
> Posture: **전부 read-only** (`directconnect:Describe*`, `ec2:Describe*`, `networkmanager:Get*/List*` 등 Describe/Get/List만). 권고는 표시 전용 — 리소스 생성/변경 없음 (ADR-005 무저촉). 라이선스 MIT-0 — 이식 시 파일 헤더에 원천 표기.

## Phase 0 — 스파이크 (go/no-go 게이트) ⬅ 지금 여기

**목적: 진짜 기능으로 넣을지 결정하기 전에, 실 데이터로 가치를 확인한다.** 프로덕션 코드·terraform 변경 없이:

1. `scripts/v2/dx-topology-spike.mjs` (throwaway) — 샘플의 5-phase 발견을 Node 스크립트로 최소 이식: DX Connections/VIFs/LAGs → DXGW+associations → TGW 연결 → (있으면) VPN/CGW. 로컬 자격증명으로 실행, 결과는 JSON 요약 출력.
2. DX가 실제 있는 계정에서 실행해 **데이터 모양·발견 커버리지 확인** (DX 없는 계정이면 샘플의 demo JSON으로 대체 검증).
3. SLA 티어 엔진을 그 JSON에 적용해 판정이 문서(DX SLA 페이지) 기준과 맞는지 수기 대조.

**게이트**: 여기서 "볼 만한 데이터가 나온다 + 판정이 맞다"가 확인되면 W1 진행. 아니면 중단하고 스파이크 폐기 — 본 계획은 보류로 남긴다.

### Phase 0 결과 (2026-08-22) — ✅ GO

demo JSON(시나리오 5종) 기반 검증 완료 — 원 저장소 클론에서 실제 엔진을 직접 실행:

- **판정 정확성**: 5개 시나리오 전부 기대 티어와 일치 (단일 로케이션→devtest, high→high, maximum→maximum + critical 권고 0건). known-answer 핀 테스트 8/8 green. 권고 내용도 문서 원칙대로 (예: devtest에 "Add a Second DX Location", high에 "로케이션별 중복 LAG").
- **이식성**: 엔진은 **외부 패키지 의존 0** (types + 상수/색상 유틸만 참조하는 순수 TS). 원 저장소 자체 엔진 테스트 307개 green — fixture와 함께 이식 가능. 규모: 평가 코어(sla-gating·resiliency-rules·bestpractice-rules·recommendation-engine·public-vif-rules·topology-builder) 약 4.6k LOC + 타입 — 캔버스 배치 파일들(layout-engine·zone-dims 등 2.8k LOC)은 awsops 토폴로지가 자체 레이아웃을 쓰므로 이식 제외.
- **무DX 계정 degrade**: 라이브 확인 — `describe-connections`/`describe-direct-connect-gateways`가 빈 배열로 정상 응답, 엔진의 `dxNotInUse` 경로와 자연 연결.
- **미검증(→W1로 이월)**: 라이브 발견의 페이지네이션·리전 엣지케이스·task role IAM — DX 보유 계정 확보 시 검증.

## W1 — 데이터층 (공유 기반)

- `web/lib/dx-topology.ts` — 5-phase 발견 이식 (awsops 라이브 lib 관례: **TTL 4분 캐시 + in-flight dedupe**, 리소스 부재 시 `available:false` degrade). v1 스코프는 **단일 계정**(호스트) — 샘플의 스포크 계정 enrich(assume-role)는 후순위 명시.
- `web/app/api/dx/topology/route.ts` — 인증(verifyUser) + 200 degrade 계약 (nfm 라우트 패턴).
- terraform: web task role에 read-only IAM 추가 (`directconnect:Describe*`, `networkmanager:Get*/List*` 등) — in-place policy 수정, SG 무접촉. plan → 컨트롤러 apply.

## W2 — 기존 메뉴로 흡수 (토폴로지 + 인벤토리)

- `web/lib/inventory-types.ts`에 타입 3종: `dx_connection` / `dx_gateway` / `dx_vif` (+`customer_gateway`는 데이터 보고 결정) — DetailPanel `sections` 필수 관례 준수.
- 토폴로지 그래프에 DX 노드·엣지 편입: `graph_catalog.py`에 리소스 추가 → 기존 TGW 노드와 연결 → 온프레미스(CGW) 종단까지. 노드 렌더러는 기존 xyflow 컴포넌트 확장.
- 결과: 신규 메뉴 없이 인벤토리 목록/상세 + 토폴로지 맵이 온프레미스 경계까지 확장.

## W3 — 신규 페이지 `/dx-resilience` (Network 그룹)

평가·권고는 "현재 상태 보기"가 아니라 "목표 대비 평가"라 토폴로지에 흡수하지 않는다 (Security/Compliance가 인벤토리와 분리된 것과 같은 원칙).

- **SLA 티어 엔진 포팅** — 순수 TS 함수로 이식 + 유닛 테스트 (Single 95% / High 99.9% / Maximum 99.99%; Enterprise Support·WA Review는 attestation-only 정보 체크).
- **DXGW별 평가 카드** — 현재 티어, 타깃 선택(High/Max), 커버리지 체크리스트, 업그레이드 경로. Unattached DXGW는 티어 미적용 배지.
- **권고 고스트 오버레이** — 샘플의 3원칙 유지(기존 리소스 제거 제안 금지 / 공유 가능한 것만 재사용 / 타깃까지 최소 추가). xyflow 점선 고스트 노드·엣지.
- i18n 4언어, 사이드바 등록(+`lib/i18n.ts` nav 키) — 페이지 신설 관례.

## W4 — 챗 콜렉터 `dx-resilience` (8번째)

- 레지스트리 계약 그대로: `available()` = DX 연결 ≥ 1, `collect()` = 토폴로지 요약 + 티어 판정 + 권고 목록을 컨텍스트로 (샘플의 system-prompt 주입 표가 그대로 수집 명세가 됨). 분석 프롬프트에 SLA 문서 근거 명시.
- 키워드 라우팅: DX/Direct Connect/전용선/VIF + 복원력·이중화 의도.

## 순서 / 브랜치

**Phase 0 → (go 판정) → W1 → W2·W3 병행 가능 → W4.** 브랜치 `feat/dx-resilience` (NFM 스택과 독립 — 공통 조상에서 분기, 파일 겹침 없음). W1의 terraform은 plan 게이트 + 컨트롤러 apply.

## Out of scope

- 스포크 계정 cross-account VPC enrich (assume-role) — W1 이후 별도
- 샘플의 SPA UI/브라우저 자격 입력/SSO backend(SAM) — 채택 안 함
- 장애 시뮬레이션·Live Status 레이어·스냅샷 공유 — 샘플 고유 기능, 필요 시 후속
- 비용 추정 챗(Pricing/Cost Explorer 연동) — 후속
- 리소스 생성/변경 일체 (ADR-005 FROZEN)
