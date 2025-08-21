import os, json, tempfile, argparse, shutil, mimetypes
import requests
from urllib.parse import urlparse

# Try to import SDK; otherwise use REST
USE_AIRTABLE_SDK = False
try:
    from airtable import Airtable  # pip install airtable-python-wrapper
    USE_AIRTABLE_SDK = True
except Exception:
    USE_AIRTABLE_SDK = False

# Your generator (provided by you)
from generate_mockups_pipeline_optimized import process_single_logo

# Python S3 uploader
from upload_s3 import upload_folder as upload_folder_to_s3

def ensure_dir(p): os.makedirs(p, exist_ok=True)

def content_type_for(url_or_path):
    guess = mimetypes.guess_type(url_or_path)[0]
    return guess or 'application/octet-stream'

def download_logo(logo_url, dest_dir):
    ensure_dir(dest_dir)
    fn = os.path.basename(urlparse(logo_url).path) or "logo.png"
    if '.' not in fn:
        # attempt by HEAD
        try:
            head = requests.head(logo_url, timeout=10)
            ct = head.headers.get('content-type','').split(';')[0]
            ext = mimetypes.guess_extension(ct) or '.png'
        except Exception:
            ext = '.png'
        fn = f"logo{ext}"
    fp = os.path.join(dest_dir, fn)
    r = requests.get(logo_url, timeout=60)
    r.raise_for_status()
    with open(fp, "wb") as f:
        f.write(r.content)
    return fp

def airtable_fetch_records_pat(base_id, table_name, pat_token):
    rows = []
    url = f"https://api.airtable.com/v0/{base_id}/{table_name}"
    headers = {"Authorization": f"Bearer {pat_token}"}
    params = {"pageSize": 100}
    while True:
        resp = requests.get(url, headers=headers, params=params, timeout=30)
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
    ap.add_argument("--logo_url", required=True)
    ap.add_argument("--products_dir", required=True)
    ap.add_argument("--product_id", required=False, help="If provided, only generate for this product_id")
    args = ap.parse_args()

    # ENV
    AIRTABLE_PAT    = os.environ.get("AIRTABLE_PAT")
    AIRTABLE_BASE_ID= os.environ.get("AIRTABLE_BASE_ID")
    AIRTABLE_TABLE  = os.environ.get("AIRTABLE_TABLE_NAME", "Products")
    AWS_BUCKET_NAME = os.environ.get("AWS_BUCKET_NAME")

    if not AIRTABLE_BASE_ID or not AIRTABLE_PAT:
        raise SystemExit("Missing AIRTABLE_BASE_ID or AIRTABLE_PAT")
    if not AWS_BUCKET_NAME:
        # We still generate files locally even if bucket missing, but upload will be skipped.
        pass

    # Fetch rows
    if USE_AIRTABLE_SDK:
        at = Airtable(AIRTABLE_BASE_ID, AIRTABLE_TABLE, AIRTABLE_PAT)
        records = at.get_all()
    else:
        records = airtable_fetch_records_pat(AIRTABLE_BASE_ID, AIRTABLE_TABLE, AIRTABLE_PAT)

    target_pid = (args.product_id or "").strip()

    # Build mockup_config: image_file -> { boxes: [...] }
    mockup_config = {}
    image_file_of_pid = None
    for rec in records:
        fields = rec["fields"] if not USE_AIRTABLE_SDK else rec.get("fields", rec)
        pid = fields.get("product_id") or fields.get("id")
        if target_pid and pid != target_pid:
            continue
        image_file = fields.get("image_file")
        boxes_raw = fields.get("boxes") or "{}"
        try:
            boxes = json.loads(boxes_raw).get("boxes", [])
        except Exception:
            boxes = []
        if image_file and boxes:
            mockup_config[image_file] = {"boxes": boxes}
            image_file_of_pid = image_file

    if not mockup_config:
        raise SystemExit("No products with bounding boxes matched selection in Airtable.")

    # Temp work dirs
    work = tempfile.mkdtemp(prefix="mockups_")
    logos_dir = os.path.join(work, "logos")
    out_dir   = os.path.join(work, "out")       // PNGs
    pdf_dir   = os.path.join(work, "pdf")       // PDFs
    prev_dir  = os.path.join(work, "preview")   // previews
    ensure_dir(out_dir); ensure_dir(pdf_dir); ensure_dir(prev_dir)

    # Download logo
    logo_path = download_logo(args.logo_url, logos_dir)
    info = (os.path.basename(logo_path), 1, 1)

    # Generate
    _ = process_single_logo(
        info,
        products_dir=args.products_dir,
        output_dir=out_dir,
        pdf_output_dir=pdf_dir,
        preview_output_dir=prev_dir,
        mockup_config=mockup_config,
        logos_dir=logos_dir
    )

    # Upload to S3 under <email>/mockups/*
    email_folder = args.email.lower().replace("@","_at_").replace(".","_dot_")
    s3_prefix = f"{email_folder}/mockups"

    uploaded_png = []
    uploaded_pdf = []
    uploaded_prev = []
    if AWS_BUCKET_NAME:
        uploaded_png  = upload_folder_to_s3(out_dir,  s3_prefix)
        uploaded_pdf  = upload_folder_to_s3(pdf_dir,  s3_prefix)
        uploaded_prev = upload_folder_to_s3(prev_dir, s3_prefix)

    # Emit a pure JSON manifest on stdout (server.js relies on this)
    manifest = {
        "email": args.email,
        "product_id": target_pid or None,
        "s3_prefix": s3_prefix,
        "product_map": {}
    }

    # Build map for each image_file in mockup_config
    for image_file in mockup_config.keys():
        # try to pick URLs that match the image filename (if possible)
        def pick(urls):
            # no strong filter here; just return them
            return urls
        manifest["product_map"][image_file] = {
            "png_urls": pick(uploaded_png),
            "pdf_urls": pick(uploaded_pdf),
            "preview_urls": pick(uploaded_prev)
        }

    print(json.dumps(manifest), flush=True)

    # Cleanup
    shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    main()
