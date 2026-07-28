import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/videos/storage.service';

interface VideoResponseBody {
  id?: string;
  title?: string;
  status?: string;
  upload_id?: string;
  parts?: { part_number: number; url: string }[];
  duration_seconds?: number | null;
  error_message?: string | null;
  created_at?: string;
  error?: string;
}

interface AuthResponseBody {
  access_token?: string;
  refresh_token?: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    const body = res.body as AuthResponseBody;
    return { access_token: body.access_token! };
  }

  describe('POST /videos', () => {
    it('cria-rascunho-com-dados-validos', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-create@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          title: 'Meu Vídeo',
          content_type: 'video/mp4',
          size_bytes: 10485760,
        })
        .expect(201);

      const body = res.body as VideoResponseBody;
      expect(body.id).toBeDefined();
      expect(body.title).toBe('Meu Vídeo');
      expect(body.status).toBe('draft');
      expect(body.upload_id).toBeTruthy();
      expect(body.parts?.length).toBeGreaterThan(0);
    });

    it('rejeita-arquivo-acima-de-10gb', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-toobig@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          title: 'Muito Grande',
          content_type: 'video/mp4',
          size_bytes: 10 * 1024 * 1024 * 1024 + 1,
        })
        .expect(400);
    });

    it('rejeita-sem-titulo', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-notitle@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ content_type: 'video/mp4', size_bytes: 1024 })
        .expect(400);
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    async function createDraft(
      accessToken: string,
    ): Promise<VideoResponseBody> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Upload Video',
          content_type: 'text/plain',
          size_bytes: 5 * 1024 * 1024,
        });
      return res.body as VideoResponseBody;
    }

    it('completa-upload-com-partes-validas', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-complete@example.com',
      );
      const draft = await createDraft(access_token);

      const partBody = Buffer.from('a'.repeat(5 * 1024 * 1024));
      const uploadResponse = await fetch(draft.parts![0].url, {
        method: 'PUT',
        body: partBody,
      });
      const etag = uploadResponse.headers.get('etag');

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const body = res.body as VideoResponseBody;
      expect(body.id).toBe(draft.id);
      expect(body.status).toBe('processing');
    }, 30000);

    it('retorna-404-para-video-de-outro-canal', async () => {
      const owner = await registerConfirmAndLogin('video-owner@example.com');
      const other = await registerConfirmAndLogin('video-other@example.com');
      const draft = await createDraft(owner.access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .send({ parts: [{ part_number: 1, etag: 'irrelevant' }] })
        .expect(404);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_FOUND');
    }, 15000);

    it('retorna-409-quando-nao-esta-em-draft', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-notdraft@example.com',
      );
      const draft = await createDraft(access_token);

      const partBody = Buffer.from('a'.repeat(5 * 1024 * 1024));
      const uploadResponse = await fetch(draft.parts![0].url, {
        method: 'PUT',
        body: partBody,
      });
      const etag = uploadResponse.headers.get('etag');

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(409);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_IN_DRAFT');
    }, 30000);
  });

  describe('GET /videos/:id', () => {
    async function createDraft(
      accessToken: string,
    ): Promise<VideoResponseBody> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Detail Video',
          content_type: 'video/mp4',
          size_bytes: 1024,
        });
      return res.body as VideoResponseBody;
    }

    it('retorna-detalhes-do-dono', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-detail@example.com',
      );
      const draft = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.id}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      const body = res.body as VideoResponseBody;
      expect(body.id).toBe(draft.id);
      expect(body.title).toBe('Detail Video');
      expect(body.status).toBe('draft');
      expect(body.duration_seconds).toBeNull();
      expect(body.error_message).toBeNull();
      expect(body.created_at).toBeDefined();
    });

    it('retorna-404-para-video-de-outro-canal', async () => {
      const owner = await registerConfirmAndLogin(
        'video-detail-owner@example.com',
      );
      const other = await registerConfirmAndLogin(
        'video-detail-other@example.com',
      );
      const draft = await createDraft(owner.access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.id}`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .expect(404);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/stream', () => {
    async function createReadyVideo(
      accessToken: string,
      content: Buffer,
    ): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Stream Video',
          content_type: 'text/plain',
          size_bytes: content.length,
        });
      const draft = res.body as VideoResponseBody;

      const storageService = app.get(StorageService);
      await storageService.putObject(
        `videos/${draft.id}/original.plain`,
        content,
        'text/plain',
      );
      const videoRepository = dataSource.getRepository(Video);
      await videoRepository.update(
        { id: draft.id },
        { status: VideoStatus.READY },
      );
      return draft.id!;
    }

    it('download-sem-range-header', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-stream-download@example.com',
      );
      const content = Buffer.from('hello streamtube video bytes');
      const id = await createReadyVideo(access_token, content);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text).toBe(content.toString());
    });

    it('streaming-com-range-header', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-stream-range@example.com',
      );
      const content = Buffer.from('0123456789');
      const id = await createReadyVideo(access_token, content);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .set('Range', 'bytes=0-3')
        .expect(206);

      expect(res.headers['content-range']).toBeDefined();
      expect(res.text).toBe('0123');
    });

    it('retorna-409-quando-video-nao-esta-pronto', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-stream-notready@example.com',
      );
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          title: 'Not Ready',
          content_type: 'video/mp4',
          size_bytes: 1024,
        });
      const draft = draftRes.body as VideoResponseBody;

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.id}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_READY');
    });

    it('retorna-404-para-video-de-outro-canal', async () => {
      const owner = await registerConfirmAndLogin(
        'video-stream-owner@example.com',
      );
      const other = await registerConfirmAndLogin(
        'video-stream-other@example.com',
      );
      const id = await createReadyVideo(owner.access_token, Buffer.from('x'));

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .expect(404);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
