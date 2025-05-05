const { S3Client } = require('@aws-sdk/client-s3');

const env = require('./env.config');

if (!env.SECRET_KEY && !env.ACCESSKEYID) return module.exports = null;

const s3 = new S3Client({
    region: env.REGION,
    credentials: {
        secretAccessKey: env.SECRET_KEY,
        accessKeyId: env.ACCESSKEYID,
    },
});

module.exports = s3;