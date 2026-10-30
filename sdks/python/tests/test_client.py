from riz import RizClient


def test_client_keeps_the_configured_base_url() -> None:
    assert RizClient("http://riz.test").base_url == "http://riz.test"
