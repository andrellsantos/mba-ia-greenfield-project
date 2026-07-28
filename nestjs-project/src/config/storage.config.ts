import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://storage:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.STORAGE_SECRET_KEY || 'minioadmin',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
}));
