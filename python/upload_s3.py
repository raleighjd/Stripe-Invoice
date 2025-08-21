import os, mimetypes, boto3

s3 = boto3.client('s3', region_name=os.getenv('AWS_REGION','us-east-2'))
BUCKET = os.environ['AWS_BUCKET_NAME']

def upload_file(local_path, key, public=True):
    ctype = mimetypes.guess_type(local_path)[0] or 'application/octet-stream'
    extra = {'ContentType': ctype}
    if public:
        extra['ACL'] = 'public-read'
    s3.upload_file(local_path, BUCKET, key, ExtraArgs=extra)
    base = os.getenv('AWS_BUCKET_URL','').rstrip('/')
    return f'{base}/{key}'

def upload_folder(local_dir, prefix):
    urls = []
    for name in os.listdir(local_dir):
        full = os.path.join(local_dir, name)
        if os.path.isfile(full):
            key = f"{prefix.rstrip('/')}/{name}"
            urls.append(upload_file(full, key, public=True))
    return urls
