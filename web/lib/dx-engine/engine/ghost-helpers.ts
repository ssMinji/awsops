// Ported from aws-samples/sample-network-resilience-agent (MIT-0),
// Copyright Amazon.com, Inc. or its affiliates. Adapted for AWSops v2
// (server-side data layer via lib/dx-topology.ts; see lib/dx-engine/adapter.ts).
import type { DxNode, DxEdge } from '../types/topology';
import { COLORS } from '../utils/colors';

export function makeGhostNode(id: string, category: string, label: string, extra?: Record<string, unknown>): DxNode {
  return {
    id,
    type: category,
    position: { x: 0, y: 0 },
    data: { label, category: category as DxNode['data']['category'], isRecommended: true, ...extra },
  };
}

export function makeGhostEdge(source: string, target: string, label?: string, labelPosition?: number): DxEdge {
  return {
    id: `e-rec-${source}-${target}`,
    source,
    target,
    type: 'customEdge',
    data: { isRecommended: true, label, ...(labelPosition != null ? { labelPosition } : {}) },
    style: { stroke: COLORS.recommended.edge },
  };
}
