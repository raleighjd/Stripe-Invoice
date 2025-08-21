import os, json, tempfile, argparse, shutil
import requests
from urllib.parse import urlparse
import mimetypes

# If you installed 'airtable-python-wrapper' use this; otherwise fall back to Airtable REST via requests.
USE_AIRTABLE_SDK = False
try:
    from airtable import Airtable  # pip install airtable-python-wrapper
    USE_AIRTABLE_SDK = True
except Exception:
    USE_AIRTABLE_SDK = False

# import your generator (must be in PYTHONPATH or same folder)
# We call the optimized pipeline's single-logo function
from generate_mockups_pipeline_optimized import process_single_logo

# Optional Python S3 uploader (uses boto3). If you prefer Node uploader, you can skip.
from upload_s3 import upload_folder as upload_folder_to_s3

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def download_logo(logo_url, dest_dir):
    ensure_dir(dest_dir)
    fn = os.path.basename(urlparse(logo_url).path) or "logo.png"
    if '.' not in fn:
        # try guess extension by mime
        ext = mimetypes.guess_extension(requests.head(logo_url, timeout=10).headers.get('content-type','').split(';')[0] or '') or '.png'
        fn = f"logo{ext}"
    fp = os.path.join(dest_dir, fn)
    r = requests.get(logo_url, timeout=30)
    r.raise_for_status()
    with open(fp, "wb") as f:
        f.write(r.content)
    return fp

def airtable_fetch_records_pat(base_id, table_name, pat_token):
    # REST fallback if no SDK
    rows = []
    url = f"https://api.airtable.com/v0/{base_id}/{table_name}"
    headers = {"Authorization": f"Bearer {pat_token}"}
    params = {"pageSize": 100}
    while True:
        resp = requests.get(url, headers=headers, params=params, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        rows.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
        params["offset"] = offset
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--logo_url", required=True, help="Remote logo URL to compose")
    ap.add_argument("--products_dir", required=True, help="Directory of base product images")
    args = ap.parse_args()

    # ENV
    AIRTABLE_PAT = os.environ.get("AIRTABLE_PAT")
    AIRTABLE_BASE_ID = os.environ.get("AIRTABLE_BASE_ID")
    AIRTABLE_TABLE_NAME = os.environ.get("AIRTABLE_TABLE_NAME", "Products")
    AWS_BUCKET_NAME = os.environ.get("AWS_BUCKET_NAME")
    AWS_REGION = os.environ.get("AWS_REGION", "us-east-2")

    if not AIRTABLE_BASE_ID or not AIRTABLE_PAT:
        raise SystemExit("Missing AIRTABLE_BASE_ID or AIRTABLE_PAT")

    # Fetch product rows from Airtable
    if USE_AIRTABLE_SDK:
        at = Airtable(AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, AIRTABLE_PAT)
        records = at.get_all()
    else:
        records = airtable_fetch_records_pat(AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, AIRTABLE_PAT)

    # Build mockup_config from Airtable rows
    mockup_config = {}
    for rec in records:
        fields = rec["fields"] if not USE_AIRTABLE_SDK else rec.get("fields", rec)
        image_file = fields.get("image_file")
        boxes_raw = fields.get("boxes") or "{}"
        try:
            boxes = json.loads(boxes_raw).get("boxes", [])
        except Exception:
            boxes = []
        if image_file and boxes:
            mockup_config[image_file] = {"boxes": boxes}

    if not mockup_config:
        raise SystemExit("No products with bounding boxes found in Airtable (field 'boxes').")

    # Prepare temp working dirs
    work = tempfile.mkdtemp(prefix="mockups_")
    logos_dir = os.path.join(work, "logos")
    out_dir   = os.path.join(work, "out")       # final PNGs
    pdf_dir   = os.path.join(work, "pdf")       # PDFs (optional from pipeline)
    prev_dir  = os.path.join(work, "preview")   # preview thumbs (optional)
    ensure_dir(out_dir); ensure_dir(pdf_dir); ensure_dir(prev_dir)

    # Save config (if your pipeline wants an external file, but we call with dict anyway)
    with open(os.path.join(work, "mockup_config.json"), "w", encoding="utf-8") as f:
        json.dump(mockup_config, f, indent=2)

    # Download logo
    logo_path = download_logo(args.logo_url, logos_dir)
    logo_name = os.path.basename(logo_path)

    # The optimized pipeline supports a one-logo "info" tuple: (filename, copies, ???)
    info = (logo_name, 1, 1)

    # Run generator (places logo per product boxes)
    result = process_single_logo(
        info,
        products_dir=args.products_dir,     # your base images directory
        output_dir=out_dir,                 # where final PNGs go
        pdf_output_dir=pdf_dir,             # where PDFs go
        preview_output_dir=prev_dir,        # where previews go
        mockup_config=mockup_config,        # dict mapping image file -> boxes[]
        logos_dir=logos_dir                 # where our downloaded logo is
    )
    print("Generator result:", result)

    # Upload to S3 under <email>/mockups/*
    email_folder = args.email.lower().replace("@","_at_").replace(".","_dot_")
    s3_prefix = f"{email_folder}/mockups"

    if not AWS_BUCKET_NAME:
      print("⚠️ AWS_BUCKET_NAME not set; skipping upload.")
    else:
      print(f"Uploading outputs to s3://{AWS_BUCKET_NAME}/{s3_prefix} ...")
      urls_png = upload_folder_to_s3(out_dir, s3_prefix)
      urls_pdf = upload_folder_to_s3(pdf_dir, s3_prefix)
      urls_prev= upload_folder_to_s3(prev_dir, s3_prefix)
      print("Uploaded PNG:", urls_png)
      print("Uploaded PDF:", urls_pdf)
      print("Uploaded preview:", urls_prev)

    # Cleanup
    shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    main()
