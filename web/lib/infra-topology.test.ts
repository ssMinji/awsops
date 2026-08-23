import { describe, it, expect } from 'vitest';
import { buildInfraGraph, idsFrom } from './infra-topology';

describe('idsFrom', () => {
  it('handles string | {GroupId} | {SubnetId} | availability_zones[].SubnetId arrays', () => {
    expect(idsFrom(['sg-1', 'sg-2'])).toEqual(['sg-1', 'sg-2']);
    expect(idsFrom([{ GroupId: 'sg-3' }])).toEqual(['sg-3']);
    expect(idsFrom([{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }])).toEqual(['subnet-a', 'subnet-b']);
    expect(idsFrom('subnet-x')).toEqual(['subnet-x']);
    expect(idsFrom(null)).toEqual([]);
  });
});

describe('buildInfraGraph', () => {
  const vpcs = [{ resource_type: 'vpc', resource_id: 'vpc-1', data: { tags: { Name: 'mgmt-vpc' } } }];
  const subnets = [{ resource_type: 'subnet', resource_id: 'subnet-a', data: { vpc_id: 'vpc-1', tags: { Name: 'app-a' } } }];
  const securityGroups = [
    { resource_type: 'security_group', resource_id: 'sg-1', data: { group_name: 'web-sg' } },
    { resource_type: 'security_group', resource_id: 'sg-def', data: { group_name: 'default' } },
  ];

  it('emits resource -> vpc/subnet/sg edges with the infra rel ontology', () => {
    const resources = [{
      resource_type: 'alb', resource_id: 'my-lb',
      data: { vpc_id: 'vpc-1', availability_zones: [{ SubnetId: 'subnet-a' }], security_groups: [{ GroupId: 'sg-1' }] },
    }];
    const g = buildInfraGraph({ resources, vpcs, subnets, securityGroups });
    const rid = 'alb:my-lb';
    expect(g.nodes.find((n) => n.id === rid)?.kind).toBe('alb');
    expect(g.nodes.find((n) => n.id === 'vpc:vpc-1')?.label).toBe('mgmt-vpc');   // inventory name wins
    expect(g.nodes.find((n) => n.id === 'subnet:subnet-a')?.label).toBe('app-a');
    expect(g.edges.map((e) => e.rel).sort()).toEqual(['infra:in_subnet', 'infra:in_vpc', 'infra:uses_sg']);
    expect(g.edges.find((e) => e.rel === 'infra:uses_sg')?.target).toBe('sg:sg-1');
  });

  it('flags the default security group on its node meta', () => {
    const g = buildInfraGraph({ resources: [], vpcs, subnets, securityGroups });
    expect(g.nodes.find((n) => n.id === 'sg:sg-def')?.meta?.default).toBe(true);
    expect(g.nodes.find((n) => n.id === 'sg:sg-1')?.meta?.default).toBe(false);
  });

  it('skips resources with no network context (not part of the infra graph)', () => {
    const resources = [{ resource_type: 'route53', resource_id: 'r1', data: { name: 'x.example.com' } }];
    const g = buildInfraGraph({ resources, vpcs: [], subnets: [], securityGroups: [] });
    expect(g.nodes.find((n) => n.id === 'route53:r1')).toBeUndefined();
    expect(g.edges).toHaveLength(0);
  });

  it('stamps meta.host from data.endpoint_address (M2 trace-topology bridge)', () => {
    const resources = [{
      resource_type: 'rds', resource_id: 'db-1',
      data: { vpc_id: 'vpc-1', endpoint_address: 'db-1.abc123.us-east-1.rds.amazonaws.com' },
    }];
    const g = buildInfraGraph({ resources, vpcs, subnets: [], securityGroups: [] });
    expect(g.nodes.find((n) => n.id === 'rds:db-1')?.meta?.host).toBe('db-1.abc123.us-east-1.rds.amazonaws.com');
  });

  it('omits meta.host when the resource has no endpoint_address', () => {
    const resources = [{ resource_type: 'alb', resource_id: 'my-lb', data: { vpc_id: 'vpc-1' } }];
    const g = buildInfraGraph({ resources, vpcs, subnets: [], securityGroups: [] });
    expect(g.nodes.find((n) => n.id === 'alb:my-lb')?.meta).not.toHaveProperty('host');
  });
});

describe('buildInfraGraph — Direct Connect absorption (W2)', () => {
  const base = { vpcs: [], subnets: [], securityGroups: [] };
  const dxRows = [
    { resource_type: 'dx_gateway', resource_id: 'dxgw-1', data: { name: 'hub', associations: [
      { gateway_id: 'tgw-1', gateway_type: 'transitGateway' },
      { gateway_id: 'vgw-9', gateway_type: 'virtualPrivateGateway' },
    ] } },
    { resource_type: 'dx_connection', resource_id: 'dxcon-1', data: { name: 'prod-dx', location: 'SEL1' } },
    { resource_type: 'dx_vif', resource_id: 'dxvif-1', data: { name: 'tvif', connection_id: 'dxcon-1', dx_gateway_id: 'dxgw-1' } },
  ];

  it('links vif -> connection/gateway and gateway -> tgw/vgw from embedded associations', () => {
    const g = buildInfraGraph({ ...base, resources: dxRows });
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const id of ['dx_gateway:dxgw-1', 'dx_connection:dxcon-1', 'dx_vif:dxvif-1', 'transit_gateway:tgw-1', 'vgw:vgw-9']) {
      expect(ids.has(id), id).toBe(true);
    }
    const rels = g.edges.map((e) => `${e.rel}:${e.source}->${e.target}`);
    expect(rels).toContain('infra:on_connection:dx_vif:dxvif-1->dx_connection:dxcon-1');
    expect(rels).toContain('infra:attached_to:dx_vif:dxvif-1->dx_gateway:dxgw-1');
    expect(rels).toContain('infra:associated:dx_gateway:dxgw-1->transit_gateway:tgw-1');
    expect(rels).toContain('infra:associated:dx_gateway:dxgw-1->vgw:vgw-9');
  });

  it('uses inventory names for dx nodes and does not route them through placement rules', () => {
    const g = buildInfraGraph({ ...base, resources: dxRows });
    const gw = g.nodes.find((n) => n.id === 'dx_gateway:dxgw-1');
    expect(gw?.label).toBe('hub');
    expect(gw?.kind).toBe('dx_gateway');
    // placement 엣지(in_vpc 등)는 생기지 않아야 함
    expect(g.edges.every((e) => !e.rel.includes('in_vpc'))).toBe(true);
  });

  it('a vif referencing a hosted connection still creates the connection stub node', () => {
    const g = buildInfraGraph({ ...base, resources: [
      { resource_type: 'dx_vif', resource_id: 'dxvif-h', data: { connection_id: 'dxcon-hosted' } },
    ] });
    expect(g.nodes.some((n) => n.id === 'dx_connection:dxcon-hosted')).toBe(true);
  });
});
