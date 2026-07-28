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

interface VideoResponseBody {
  id?: string;
  title?: string;
  status?: string;
  upload_id?: string;
  parts?: { part_number: number; url: string }[];
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
});
