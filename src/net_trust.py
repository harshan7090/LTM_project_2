"""
Make Python trust the operating system's certificate store.

WHY THIS IS NEEDED

  On a corporate network the TLS connection is usually intercepted: the proxy
  terminates it, re-signs with an internal root CA, and that CA is installed
  in the Windows certificate store. Browsers read that store, so the site
  loads. Python does not - it ships its own CA bundle - so the identical
  request fails with:

      CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate

  The failure looks exactly like the host being unreachable, which is how it
  was misdiagnosed here: `curl https://openrouter.ai` returned 000 and the
  conclusion drawn was "no network". It was reachable the whole time; only
  the trust store was wrong. `curl -k` returned 200 and settled it.

  (curl failed differently, with CRYPT_E_NO_REVOCATION_CHECK - schannel could
  not reach the revocation endpoint. Same root cause, different client.)

WHY truststore AND NOT pip-system-certs

  `truststore` delegates verification to the OS trust store through the
  standard `ssl` module. It is the approach pip itself adopted, needs no
  monkeypatching of requests/httpx internals, and works for anything built on
  `ssl` - which is httpx, requests and urllib alike.

  It is also strictly SAFER than the alternatives that get reached for when
  this error appears: disabling verification (`verify=False`, `curl -k`) or
  pinning REQUESTS_CA_BUNDLE to something permissive. Those turn a trust
  problem into no trust at all. This keeps full verification and simply uses
  the certificates the machine is actually configured to trust.

  Calling it is a no-op when truststore is absent or the platform has no
  usable store, so nothing here can prevent the app from starting.
"""
from __future__ import annotations

_ENABLED = False
_DETAIL = "not attempted"


def enable() -> bool:
    """Route TLS verification through the OS trust store. Idempotent."""
    global _ENABLED, _DETAIL
    if _ENABLED:
        return True
    try:
        import truststore
        truststore.inject_into_ssl()
        _ENABLED = True
        _DETAIL = "using the operating system certificate store"
    except ImportError:
        _DETAIL = ("truststore is not installed - TLS uses Python's bundled CA "
                   "list. On a network with an intercepting proxy this shows up "
                   "as CERTIFICATE_VERIFY_FAILED. Fix: pip install truststore")
    except Exception as exc:  # noqa: BLE001
        _DETAIL = f"truststore could not be enabled: {exc}"
    return _ENABLED


def status() -> dict:
    return {"os_trust_store": _ENABLED, "detail": _DETAIL}
