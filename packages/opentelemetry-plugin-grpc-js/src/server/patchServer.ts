/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as grpcJs from '@grpc/grpc-js';
import type { HandleCall } from '@grpc/grpc-js/build/src/server-call';
import { GrpcJsPlugin } from '../grpcJs';
import * as shimmer from 'shimmer';
import {
  ServerCallWithMeta,
  SendUnaryDataCallback,
  IgnoreMatcher,
} from '../types';
import {
  context,
  SpanOptions,
  SpanKind,
  propagation,
  Span,
  ROOT_CONTEXT,
  setSpan,
  diag,
} from '@opentelemetry/api';
import { RpcAttribute } from '@opentelemetry/semantic-conventions';
import { clientStreamAndUnaryHandler } from './clientStreamAndUnary';
import { serverStreamAndBidiHandler } from './serverStreamAndBidi';
import { methodIsIgnored } from '../utils';

type ServerRegisterFunction = typeof grpcJs.Server.prototype.register;

/**
 * Patch for grpc.Server.prototype.register(...) function. Provides auto-instrumentation for
 * client_stream, server_stream, bidi, unary server handler calls.
 */
export function patchServer(
  this: GrpcJsPlugin
): (originalRegister: ServerRegisterFunction) => ServerRegisterFunction {
  return (originalRegister: ServerRegisterFunction) => {
    const plugin = this;
    const config = this._config;

    diag.debug('patched gRPC server');
    return function register<RequestType, ResponseType>(
      this: grpcJs.Server,
      name: string,
      handler: HandleCall<unknown, unknown>,
      serialize: grpcJs.serialize<unknown>,
      deserialize: grpcJs.deserialize<unknown>,
      type: string
    ): boolean {
      const originalRegisterResult = originalRegister.call(
        this,
        name,
        handler,
        serialize,
        deserialize,
        type
      );
      const handlerSet = this['handlers'].get(name);

      shimmer.wrap(
        handlerSet,
        'func',
        (originalFunc: HandleCall<unknown, unknown>) => {
          return function func(
            this: typeof handlerSet,
            call: ServerCallWithMeta<RequestType, ResponseType>,
            callback: SendUnaryDataCallback<unknown>
          ) {
            const self = this;

            if (
              shouldNotTraceServerCall(
                call.metadata,
                name,
                config.ignoreGrpcMethods
              )
            ) {
              return handleUntracedServerFunction(
                type,
                originalFunc,
                call,
                callback
              );
            }

            const spanName = `grpc.${name.replace('/', '')}`;
            const spanOptions: SpanOptions = {
              kind: SpanKind.SERVER,
            };

            diag.debug('patch func: %s', JSON.stringify(spanOptions));

            context.with(
              propagation.extract(ROOT_CONTEXT, call.metadata, {
                get: (carrier, key) => carrier.get(key).map(String),
                keys: carrier => Object.keys(carrier.getMap()),
              }),
              () => {
                const span = plugin.tracer
                  .startSpan(spanName, spanOptions)
                  .setAttributes({
                    [RpcAttribute.GRPC_KIND]: spanOptions.kind,
                  });

                context.with(setSpan(context.active(), span), () => {
                  handleServerFunction.call(
                    self,
                    plugin,
                    span,
                    type,
                    originalFunc,
                    call,
                    callback
                  );
                });
              }
            );
          };
        }
      );
      return originalRegisterResult;
    } as typeof grpcJs.Server.prototype.register;
  };
}

/**
 * Returns true if the server call should not be traced.
 */
function shouldNotTraceServerCall(
  metadata: grpcJs.Metadata,
  methodName: string,
  ignoreGrpcMethods?: IgnoreMatcher[]
): boolean {
  const parsedName = methodName.split('/');
  return methodIsIgnored(
    parsedName[parsedName.length - 1] || methodName,
    ignoreGrpcMethods
  );
}

/**
 * Patch callback or EventEmitter provided by `originalFunc` and set appropriate `span`
 * properties based on its result.
 */
function handleServerFunction<RequestType, ResponseType>(
  this: unknown,
  plugin: GrpcJsPlugin,
  span: Span,
  type: string,
  originalFunc: HandleCall<RequestType, ResponseType>,
  call: ServerCallWithMeta<RequestType, ResponseType>,
  callback: SendUnaryDataCallback<unknown>
): void {
  switch (type) {
    case 'unary':
    case 'clientStream':
    case 'client_stream':
      return clientStreamAndUnaryHandler(
        plugin,
        span,
        call,
        callback,
        originalFunc as
          | grpcJs.handleUnaryCall<RequestType, ResponseType>
          | grpcJs.ClientReadableStream<RequestType>
      );
    case 'serverStream':
    case 'server_stream':
    case 'bidi':
      return serverStreamAndBidiHandler(
        plugin,
        span,
        call,
        originalFunc as
          | grpcJs.handleBidiStreamingCall<RequestType, ResponseType>
          | grpcJs.handleServerStreamingCall<RequestType, ResponseType>
      );
    default:
      break;
  }
}

/**
 * Does not patch any callbacks or EventEmitters to omit tracing on requests
 * that should not be traced.
 */
function handleUntracedServerFunction<RequestType, ResponseType>(
  type: string,
  originalFunc: HandleCall<RequestType, ResponseType>,
  call: ServerCallWithMeta<RequestType, ResponseType>,
  callback: SendUnaryDataCallback<unknown>
): void {
  switch (type) {
    case 'unary':
    case 'clientStream':
    case 'client_stream':
      return (originalFunc as Function).call({}, call, callback);
    case 'serverStream':
    case 'server_stream':
    case 'bidi':
      return (originalFunc as Function).call({}, call);
    default:
      break;
  }
}
