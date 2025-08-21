import os, mimetypes, boto3

REGION   = os.getenv('AWS_REGION', 'us-east-2')
BUCKET   = os.environ.get('AWS_BUCKET_NAME')
BASE_URL = (os.getenv('AWS_BUCKET_URL','')).rstrip('/')

if not BUCKET:
    raise RuntimeError("AWS_BUCKET_NAME is required for upload_s3.py")

s3 = boto3.client('s3', region_name=REGION)

def upload_file(local_path, key, public=True):
    ctype = mimetypes.guess_type(local_path)[0] or 'application/octet-stream'
    extra = {'ContentType': ctype}
    if public:
        extra['ACL'] = 'public-read'
    s3.upload_file(local_path, BUCKET, key, ExtraArgs=extra)
    return f'{BASE_URL}/{key}' if BASE_URL else f's3://{BUCKET}/{key}'

def upload_folder(local_dir, prefix):
    urls = []
    if not os.path.isdir(local_dir):
        return urls
    for name in os.listdir(local_dir):
        full = os.path.join(local_dir, name)
        if os.path.isfile(full):
            key = f"{prefix.rstrip('/')}/{name}"
            urls.append(upload_file(full, key, public=True))
    return urls
