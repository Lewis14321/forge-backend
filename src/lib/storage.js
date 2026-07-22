const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
}

const BUCKET = () => process.env.R2_BUCKET_NAME || 'forge-files';

async function getUploadUrl(key, contentType, expiresIn = 300) {
  const client = getClient();
  if (!client) throw new Error('R2 not configured');
  return getSignedUrl(client, new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    ContentType: contentType,
  }), { expiresIn });
}

async function getDownloadUrl(key, filename, expiresIn = 3600) {
  const client = getClient();
  if (!client) throw new Error('R2 not configured');
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  }), { expiresIn });
}

async function deleteFile(key) {
  const client = getClient();
  if (!client) throw new Error('R2 not configured');
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
}

module.exports = { getUploadUrl, getDownloadUrl, deleteFile };
