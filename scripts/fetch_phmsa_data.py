"""
Downloads REAL pipeline incident data from PHMSA (the U.S. Dept. of
Transportation's Pipeline and Hazardous Materials Safety Administration) —
the official regulator that collects incident reports (including
corrosion-caused failures) from every U.S. pipeline operator.

Source page: https://www.phmsa.dot.gov/data-and-statistics/pipeline/pipeline-incident-flagged-files
This is a static file, no API key or auth needed.

Usage:
    python scripts/fetch_phmsa_data.py

This unzips the download and then PRINTS the structure of every file inside
(sheet names, columns, row counts) rather than guessing column names —
PHMSA's schema has changed over the years and varies by pipeline type (gas
distribution vs. gas transmission vs. hazardous liquid), so the honest first
step is to actually look at what you got before writing feature engineering
against it.
"""
import argparse
import ssl
import sys
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config.settings import settings  # noqa: E402

PHMSA_URL = (
    "https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/data_statistics/"
    "pipeline/PHMSA_Pipeline_Safety_Flagged_Incidents.zip"
)

SSL_HELP = """
This is a CERTIFICATE_VERIFY_FAILED error, not a PHMSA/network-down problem.
It means Python couldn't build a trust chain to phmsa.dot.gov's certificate.
By far the most common cause on a corporate laptop: your company's network
runs SSL-inspecting security software (Zscaler, Netskope, corporate proxy,
antivirus web-shield, etc.) that re-signs HTTPS traffic with its OWN root
certificate. Windows trusts that root certificate (IT pushed it via policy),
but Python's bundled certificate store (from the `certifi` package) doesn't
know about it — so Python, and only Python, rejects the connection.

Try these in order — stop as soon as one works:

  1. Make Python use Windows' own certificate store (fixes it permanently,
     recommended first — this is almost always the actual fix):
         pip install pip-system-certs
     Then just re-run this script. No code changes needed.

  2. Update your CA bundle (occasionally the fix if #1 doesn't apply):
         pip install --upgrade certifi

  3. If you're off the corporate network (e.g. on personal wifi/hotspot)
     and it still fails, ask IT for the corporate root CA .pem file and set:
         set REQUESTS_CA_BUNDLE=C:\\path\\to\\corporate-root-ca.pem   (cmd)
         $env:REQUESTS_CA_BUNDLE="C:\\path\\to\\corporate-root-ca.pem" (PowerShell)

  4. Last resort ONLY (disables certificate verification for this one
     download — fine for grabbing a public government dataset for a class
     project, NOT a habit to build for anything sensitive):
         python scripts/fetch_phmsa_data.py --insecure
"""


def download_and_extract(insecure: bool = False) -> Path:
    zip_path = settings.DATA_RAW_DIR / "phmsa_flagged_incidents.zip"
    extract_dir = settings.DATA_RAW_DIR / "phmsa_flagged_incidents"

    print(f"Downloading {PHMSA_URL} ...")
    try:
        resp = requests.get(
            PHMSA_URL,
            timeout=120,
            headers={"User-Agent": "Mozilla/5.0 (IntegrityAI research)"},
            verify=not insecure,
        )
        resp.raise_for_status()
    except requests.exceptions.SSLError:
        if insecure:
            raise  # --insecure already set and it still failed — a real problem, don't swallow it
        print(SSL_HELP)
        sys.exit(1)

    if insecure:
        print("WARNING: certificate verification was disabled for this download (--insecure).")

    zip_path.write_bytes(resp.content)
    print(f"Downloaded {len(resp.content):,} bytes to {zip_path}")

    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)
        names = zf.namelist()
    print(f"Extracted {len(names)} file(s) to {extract_dir}")
    return extract_dir


def inspect_files(extract_dir: Path) -> None:
    import pandas as pd

    for path in sorted(extract_dir.rglob("*")):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        print(f"\n{'=' * 70}\n{path.name}\n{'=' * 70}")

        try:
            if suffix in (".xlsx", ".xls"):
                sheets = pd.read_excel(path, sheet_name=None, nrows=5)
                for sheet_name, df in sheets.items():
                    print(f"\n[sheet: {sheet_name}] columns ({len(df.columns)}):")
                    print(list(df.columns))
            elif suffix == ".csv":
                df = pd.read_csv(path, nrows=5, low_memory=False)
                print(f"columns ({len(df.columns)}):")
                print(list(df.columns))
            else:
                print("(not a spreadsheet — skipping preview)")
        except Exception as e:  # noqa: BLE001
            print(f"Could not preview: {e}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--insecure", action="store_true",
        help="Skip TLS certificate verification (last resort — see SSL_HELP if you hit a cert error).",
    )
    args = parser.parse_args()

    extract_dir = download_and_extract(insecure=args.insecure)
    print("\nInspecting contents (first 5 rows' worth of columns per sheet)...")
    inspect_files(extract_dir)
    print(
        "\nDone. Look for columns mentioning CAUSE, CORROSION, MATERIAL, "
        "INSTALL/AGE, DIAMETER, PRESSURE — those are your feature/label candidates. "
        "Once you know the real column names, tell me and I'll wire up the "
        "preprocessing to match exactly."
    )


if __name__ == "__main__":
    main()
