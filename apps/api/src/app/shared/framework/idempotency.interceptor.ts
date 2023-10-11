import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CacheService } from '@novu/application-generic';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { IJwtPayload } from '@novu/shared';

const LOG_CONTEXT = 'IdempotencyInterceptor';
const IDEMPOTENCY_CACHE_TTL = 60 * 60 * 24; //24h
const IDEMPOTENCY_PROGRESS_TTL = 60 * 5; //5min

const HEADER_KEYS = {
  IDEMPOTENCY_KEY: 'idempotency-key',
  RETRY_AFTER: 'retry-after',
  IDEMPOTENCY_CONFLICT: 'x-idempotency-conflict',
  IDEMPOTENCY_REPLAY: 'idempotency-replay',
  LINK: 'link',
};

const DOCS_LINK = 'docs.novu.co/idempotency';

enum IdempotencyConflictEnum {
  REQUEST_PROCESSING = 'REQUEST_PROCESSING',
  DIFFERENT_BODY = 'DIFFERENT_BODY',
}

enum ReqStatusEnum {
  PROGRESS = 'in-progress',
  SUCCESS = 'success',
  ERROR = 'error',
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly cacheService: CacheService) { }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = this.getIdempotencyKey(context);
    const isEnabled = process.env.API_IDEMPOTENCY_ENABLED == 'true';
    if (!isEnabled || !idempotencyKey || !['post', 'patch'].includes(request.method.toLowerCase())) {
      return next.handle();
    }
    const cacheKey = this.getCacheKey(context);

    try {
      const bodyHash = this.hashRequestBody(request.body);
      //if 1st time we are seeing the request, marks the request as in-progress if not, does nothing
      const isNewReq = await this.setCache(
        cacheKey,
        { status: ReqStatusEnum.PROGRESS, bodyHash },
        IDEMPOTENCY_PROGRESS_TTL,
        true
      );
      // Check if the idempotency key is in the cache
      if (isNewReq) {
        return await this.handleNewRequest(context, next, bodyHash);
      } else {
        return await this.handlerDuplicateRequest(context, bodyHash);
      }
    } catch (err) {
      Logger.warn(
        `An error occurred while making idempotency check, proceeding without idempotency. key:${idempotencyKey}. error: ${err.message}`,
        LOG_CONTEXT
      );
    }

    //something unexpected happened, both cached response and handler did not execute as expected
    return throwError(() => new ServiceUnavailableException());
  }

  private getIdempotencyKey(context: ExecutionContext): string | undefined {
    const request = context.switchToHttp().getRequest();

    return request.headers[HEADER_KEYS.IDEMPOTENCY_KEY];
  }

  private getReqUser(context: ExecutionContext): IJwtPayload | null {
    const req = context.switchToHttp().getRequest();
    if (req?.user?.organizationId) {
      return req.user;
    }
    if (req.headers?.authorization?.length) {
      const token = req.headers.authorization.split(' ')[1];
      if (token) {
        return jwt.decode(token);
      }
    }

    return null;
  }

  private getCacheKey(context: ExecutionContext): string {
    const { organizationId } = this.getReqUser(context) || {};
    const env = process.env.NODE_ENV;

    return `${env}-${organizationId}-${this.getIdempotencyKey(context)}`;
  }

  async setCache(
    key: string,
    val: { status: ReqStatusEnum; bodyHash: string; data?: any; statusCode?: number },
    ttl: number,
    ifNotExists?: boolean
  ): Promise<string | null> {
    try {
      if (ifNotExists) {
        return await this.cacheService.setIfNotExist(key, JSON.stringify(val), { ttl });
      }
      await this.cacheService.set(key, JSON.stringify(val), { ttl });
    } catch (err) {
      Logger.warn(`An error occurred while setting idempotency cache, key:${key} error: ${err.message}`, LOG_CONTEXT);
    }

    return null;
  }

  private buildError(error: any): HttpException {
    const statusCode = error.status || error.response?.statusCode || 500;
    if (statusCode == 500 && !error.response) {
      //some unhandled exception occurred
      return new InternalServerErrorException();
    }

    return new HttpException(error.response || error.message, statusCode, error.response?.options);
  }

  private setHeaders(response: any, headers: Record<string, string>) {
    Object.keys(headers).map((key) => {
      if (headers[key]) {
        response.set(key, headers[key]);
      }
    });
  }

  private hashRequestBody(body: object): string {
    const hash = createHash('blake2s256');
    hash.update(Buffer.from(JSON.stringify(body)));

    return hash.digest('hex');
  }

  private async handlerDuplicateRequest(context: ExecutionContext, bodyHash: string): Promise<Observable<any>> {
    const cacheKey = this.getCacheKey(context);
    const idempotencyKey = this.getIdempotencyKey(context)!;
    const data = await this.cacheService.get(cacheKey);
    this.setHeaders(context.switchToHttp().getResponse(), { [HEADER_KEYS.IDEMPOTENCY_KEY]: idempotencyKey });
    const parsed = JSON.parse(data);
    if (parsed.status === ReqStatusEnum.PROGRESS) {
      // api call is in progress, so client need to handle this case
      Logger.error(`previous api call in progress rejecting the request. key:${idempotencyKey}`, LOG_CONTEXT);
      this.setHeaders(context.switchToHttp().getResponse(), {
        [HEADER_KEYS.IDEMPOTENCY_CONFLICT]: IdempotencyConflictEnum.REQUEST_PROCESSING,
        [HEADER_KEYS.RETRY_AFTER]: `1`,
      });

      return throwError(
        () =>
          new HttpException(
            `Request with key "${idempotencyKey}" is currently being processed. Please retry after 1 second`,
            429
          )
      );
    }
    if (bodyHash !== parsed.bodyHash) {
      //different body sent than before
      Logger.error(`idempotency key is being reused for different bodies. key:${idempotencyKey}`, LOG_CONTEXT);
      this.setHeaders(context.switchToHttp().getResponse(), {
        [HEADER_KEYS.IDEMPOTENCY_CONFLICT]: IdempotencyConflictEnum.DIFFERENT_BODY,
        [HEADER_KEYS.LINK]: DOCS_LINK,
      });

      throw new UnprocessableEntityException(`Request with key "${idempotencyKey}" is being reused for a different body`)
    }
    this.setHeaders(context.switchToHttp().getResponse(), { [HEADER_KEYS.IDEMPOTENCY_REPLAY]: 'true' });

    //already seen the request return cached response
    if (parsed.status === ReqStatusEnum.ERROR) {
      Logger.error(`returning cached error response. key:${idempotencyKey}`, LOG_CONTEXT);

      return throwError(() => this.buildError(parsed.data));
    }

    return of(parsed.data);
  }

  private async handleNewRequest(
    context: ExecutionContext,
    next: CallHandler,
    bodyHash: string
  ): Promise<Observable<any>> {
    const cacheKey = this.getCacheKey(context);
    const idempotencyKey = this.getIdempotencyKey(context)!;

    return next.handle().pipe(
      map(async (response) => {
        const httpResponse = context.switchToHttp().getResponse();
        const statusCode = httpResponse.statusCode;

        // Cache the success response and return it
        await this.setCache(
          cacheKey,
          { status: ReqStatusEnum.SUCCESS, bodyHash, statusCode: statusCode, data: response },
          IDEMPOTENCY_CACHE_TTL
        );
        Logger.verbose(`cached the success response for idempotency key:${idempotencyKey}`, LOG_CONTEXT);
        this.setHeaders(httpResponse, { [HEADER_KEYS.IDEMPOTENCY_KEY]: idempotencyKey });

        return response;
      }),
      catchError((err) => {
        const httpException = this.buildError(err);
        // Cache the error response and return it
        const error = err instanceof HttpException ? err : httpException;
        this.setCache(
          cacheKey,
          {
            status: ReqStatusEnum.ERROR,
            statusCode: httpException.getStatus(),
            bodyHash,
            data: error,
          },
          IDEMPOTENCY_CACHE_TTL
        ).catch(() => { });
        Logger.verbose(`cached the error response for idempotency key:${idempotencyKey}`, LOG_CONTEXT);
        this.setHeaders(context.switchToHttp().getResponse(), { [HEADER_KEYS.IDEMPOTENCY_KEY]: idempotencyKey });

        return throwError(() => error);
      })
    );
  }
}
