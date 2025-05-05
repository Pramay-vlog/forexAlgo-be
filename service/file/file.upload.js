const multer = require('multer');
const multerS3 = require('multer-s3');
const s3 = require('../../config/s3.config');
const env = require('../../config/env.config');
const BASE_DIR = `${env.PROJECT_NAME}/${env.NODE_ENV}`;
const { HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: env.BUCKET,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const dir = getDirectory({ fieldName: file.fieldname });

            //! file name will be generated from following
            const fileName = `${new Date().getTime()}-${(new Date().getTime()) * Math.random()}-${file.originalname}`;
            cb(null, `${BASE_DIR}/${dir}/${fileName}`);
        },
    }),

    limits: { fileSize: 1024 * 1024 * 20, files: 10 },
});


// delete file from s3
// Key format one: https://bucket-name.s3.region.amazonaws.com/project-name/node-env/file-name
const deleteFile = async ({ Key, Bucket = env.BUCKET } = {}) => {
    try {
        if (Key.startsWith('http')) Key = Key.split('.com')[1].substr(1);
        if (!await s3.send(new HeadObjectCommand({ Key, Bucket }))) return null;

        const data = await s3.send(new DeleteObjectCommand({ Key, Bucket }));
        return data;
    } catch (error) {
        return null;
    }
};

module.exports = {
    upload,
    deleteFile,
};