import os, json, tempfile, argparse, shutil
import requests
from airtable import Airtable
from urllib.parse import urlparse
from PIL import Image
from generate_mockups_pipeline_optimized import (
    process_single_logo, load_product_images_cached
)

# Minimal fast uploader with boto3 or awscli – here we shell to awscli for brevity.
def upload_folder_to_s3(local_dir, s3_prefix):
    for root, _, files in os.walk(local_dir):
        for f in files:
            local = os.path.join(root, f)
            key = os.path.relpath(local, local_dir).replace("\\","/")
            os.system(f'aws s3 cp "{local}" "s3://{os.environ["AWS_BUCKET_NAME"]}/{s3_prefix}/{key}" --region {os.environ["AWS_REGION"]}')

def download_logo(logo_url, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    fn = os.path.basename(urlparse(logo_url).path) or "logo.png"
    fp = os.path.join(dest_dir, fn)
    r = requests.get(logo_url, timeout=20)
    r.raise_for_status()
    with open(fp, "wb") as f:
        f.write(r.content)
    return fp

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--logo_url", required=True, help="Remote logo URL to compose")
    ap.add_argument("--products_dir", default="../public/images/products")
    ap.add_argument("--preview_only", action="store_true")
    args = ap.parse_args()

    # Airtable
    base_id = os.environ["AIRTABLE_BASE_ID"]
    api_key = os.environ["AIRTABLE_API_KEY"]
    table = os.environ.get("AIRTABLE_TABLE_NAME", "Products")
    at = Airtable(base_id, table, api_key)

    # Build mockup_config from Airtable rows
    records = at.get_all()
    mockup_config = {}
    for rec in records:
        fields = rec["fields"]
        image_file = fields.get("image_file")
        boxes_raw = fields.get("boxes") or "{}"
        try:
            boxes = json.loads(boxes_raw).get("boxes", [])
        except Exception:
            boxes = []
        if image_file and boxes:
            mockup_config[image_file] = {"boxes": boxes}

    # Temp working dirs
    work = tempfile.mkdtemp(prefix="mockups_")
    logos_dir = os.path.join(work, "logos")
    out_dir   = os.path.join(work, "out")
    pdf_dir   = os.path.join(work, "pdf")
    prev_dir  = os.path.join(work, "preview")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(pdf_dir, exist_ok=True)
    os.makedirs(prev_dir, exist_ok=True)

    # Save config
    with open(os.path.join(work, "mockup_config.json"), "w") as f:
        json.dump(mockup_config, f, indent=2)

    # Download logo
    logo_path = download_logo(args.logo_url, logos_dir)
    logo_name = os.path.basename(logo_path)

    # Generate mockups (one “logo” batch)
    info = (logo_name, 1, 1)
    result = process_single_logo(
        info,
        products_dir=args.products_dir,
        output_dir=out_dir,
        pdf_output_dir=pdf_dir,
        preview_output_dir=prev_dir,
        mockup_config=mockup_config,
        logos_dir=logos_dir
    )
    print(result)

    # Upload to S3 under <email>/mockups/*
    email_folder = args.email.lower().replace("@","_at_").replace(".","_dot_")
    s3_prefix = f"{email_folder}/mockups"
    upload_folder_to_s3(out_dir, s3_prefix)
    upload_folder_to_s3(pdf_dir, s3_prefix)
    upload_folder_to_s3(prev_dir, s3_prefix)

    shutil.rmtree(work)

if __name__ == "__main__":
    main()
