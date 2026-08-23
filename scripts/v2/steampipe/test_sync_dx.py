"""W2 DX absorption: dx_connection / dx_gateway / dx_vif SDK syncs. Validates registry membership,
the region-discovery breadcrumb (DXGW attachments' virtualInterfaceRegion), association embedding
on dx_gateway rows (the infra graph builds dx_gateway -> tgw/vgw edges from it), and per-region
fail-open (one denied region must not blank the type). Loader mirrors test_sync_lambda_queries.py
(pg8000/boto3 stubbed via sys.modules; no live AWS)."""
import importlib.util
import sys
import types
from pathlib import Path


def load_sync_lambda():
    root = Path(__file__).resolve().parent
    sys.modules.setdefault("boto3", types.SimpleNamespace(client=lambda *a, **k: object()))
    sys.modules.setdefault("pg8000", types.SimpleNamespace(native=types.SimpleNamespace(Connection=object)))
    sys.modules.setdefault("pg8000.native", types.SimpleNamespace(Connection=object))
    sys.modules.setdefault("botocore", types.SimpleNamespace())
    sys.modules.setdefault("botocore.exceptions", types.SimpleNamespace(ClientError=Exception))
    spec = importlib.util.spec_from_file_location("sync_lambda_under_test", root / "sync_lambda.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class FakeDx:
    """Regional directconnect stub — behavior keyed by region."""

    def __init__(self, region):
        self.region = region

    def describe_direct_connect_gateways(self, **kw):
        return {"directConnectGateways": [{
            "directConnectGatewayId": "dxgw-1", "directConnectGatewayName": "hub",
            "amazonSideAsn": 64512, "directConnectGatewayState": "available", "ownerAccount": "111",
        }]}

    def describe_direct_connect_gateway_associations(self, **kw):
        return {"directConnectGatewayAssociations": [{
            "associationId": "a-1", "associationState": "associated",
            "associatedGateway": {"id": "tgw-1", "type": "transitGateway", "region": "us-east-1", "ownerAccount": "111"},
        }]}

    def describe_direct_connect_gateway_attachments(self, **kw):
        return {"directConnectGatewayAttachments": [{"virtualInterfaceRegion": "us-east-1"}]}

    def describe_connections(self, **kw):
        if self.region == "us-east-1":
            raise RuntimeError("AccessDenied")  # 한 리전 거부 → 타입 전체가 비면 안 됨
        return {"connections": [{
            "connectionId": "dxcon-1", "connectionName": "c1", "connectionState": "available",
            "region": self.region, "location": "SEL1", "bandwidth": "10Gbps",
            "tags": [{"key": "Name", "value": "prod-dx"}],
        }]}

    def describe_virtual_interfaces(self, **kw):
        return {"virtualInterfaces": [{
            "virtualInterfaceId": f"dxvif-{self.region}", "virtualInterfaceName": "tvif",
            "virtualInterfaceState": "available", "virtualInterfaceType": "transit",
            "vlan": 100, "asn": 65000, "connectionId": "dxcon-1",
            "directConnectGatewayId": "dxgw-1", "region": self.region,
            "bgpPeers": [{"bgpPeerState": "available", "bgpStatus": "up", "asn": 65000}],
        }]}


def load_with_fake_dx(monkeypatch):
    mod = load_sync_lambda()
    monkeypatch.setattr(mod, "boto3", types.SimpleNamespace(
        client=lambda service, region_name=None, **kw: FakeDx(region_name)))
    monkeypatch.setenv("AWS_REGION", "ap-northeast-2")
    return mod


def test_dx_types_registered():
    mod = load_sync_lambda()
    for t in ("dx_connection", "dx_gateway", "dx_vif"):
        assert t in mod.SDK_SYNCS
        assert t in mod._ALLOWED


def test_dx_gateway_rows_embed_associations(monkeypatch):
    mod = load_with_fake_dx(monkeypatch)
    rows, id_col, region_col = mod._fetch_dx_gateways()
    assert (id_col, region_col) == ("resource_id", "region")
    assert rows[0]["resource_id"] == "dxgw-1"
    assert rows[0]["region"] == "global"  # DXGW는 글로벌 리소스
    assert rows[0]["associations"][0]["gateway_id"] == "tgw-1"
    assert rows[0]["associations"][0]["gateway_type"] == "transitGateway"


def test_dx_vifs_fan_out_to_discovered_regions(monkeypatch):
    mod = load_with_fake_dx(monkeypatch)
    rows, _, _ = mod._fetch_dx_vifs()
    # 홈 리전 + attachment 단서(us-east-1) 양쪽에서 수집됐는지
    assert {r["region"] for r in rows} == {"ap-northeast-2", "us-east-1"}


def test_dx_connections_survive_one_denied_region(monkeypatch):
    mod = load_with_fake_dx(monkeypatch)
    rows, _, _ = mod._fetch_dx_connections()
    # us-east-1은 AccessDenied로 skip — 홈 리전 행은 살아있어야 함 + 태그 dict 변환
    assert [r["resource_id"] for r in rows] == ["dxcon-1"]
    assert rows[0]["tags"] == {"Name": "prod-dx"}
