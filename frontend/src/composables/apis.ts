import { useSnackbar } from '@/composables/use-snackbar';
import { i18n } from '@/plugins/i18n';
import { remote } from '@/plugins/remote';
import { network } from '@/store';
import { apiStore } from '@/store/api';
import type { Api } from '@jellyfin/sdk';
import type { BaseItemDto, BaseItemDtoQueryResult } from '@jellyfin/sdk/lib/generated-client';
import type { AxiosResponse } from 'axios';
import { isEqual } from 'lodash-es';
import { computed, effectScope, getCurrentScope, isRef, ref, toValue, unref, watch, type ComputedRef, type MaybeRef, type Ref } from 'vue';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
/**
 * BetterOmit still provides IntelliSense fedback, unlike the built-in Omit type.
 * See https://github.com/microsoft/TypeScript/issues/56135
 */
type BetterOmit<T, K extends keyof any> = T extends Record<any, any>
  ? {
      [P in keyof T as P extends K ? never : P]: T[P]
    }
  : T;
/**
 * Make all the properties of a type mutable.
 */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};
type OmittedKeys = 'fields' | 'userId' | 'enableImages' | 'enableTotalRecordCount' | 'enabledImageTypes';
type ParametersAsGetters<T extends (...args: any[]) => any> = T extends (...args: infer P) => any
  ? { [K in keyof P]: () => BetterOmit<Mutable<P[K]>, OmittedKeys> }
  : never;
type ExtractResponseDataType<T> = Awaited<T> extends AxiosResponse<infer U, any> ? U : undefined;
type Validate<T, U> = T extends U ? U : never;
type ComposableParams<T extends Record<K, (...args: any[]) => any>, K extends keyof T, U extends ParametersAsGetters<T[K]>> =
  Validate<ParametersAsGetters<T[K]>, U>;
/**
 * If response.data is BaseItemDto or BaseItemDto[], returns it. Otherwise, returns undefined.
 */
type ExtractBaseItemDtoResponse<T> =
  (ExtractResponseDataType<T> extends BaseItemDto ? BaseItemDto :
  (ExtractResponseDataType<T> extends BaseItemDtoQueryResult ? BaseItemDto[] :
  ExtractResponseDataType<T> extends BaseItemDto[] ? BaseItemDto[] : undefined));
/**
 * If response.data is BaseItemDto or BaseItemDto[], returns undefined. Otherwise, returns the data type.
 */
type ExtractResponseType<T> =
  (ExtractResponseDataType<T> extends BaseItemDto ? undefined :
  (ExtractResponseDataType<T> extends BaseItemDtoQueryResult ? undefined :
  ExtractResponseDataType<T>));

type ReturnData<T extends Record<K, (...args: any[]) => any>, K extends keyof T, J extends boolean> =
  J extends true ? ExtractBaseItemDtoResponse<ReturnType<T[K]>> : ExtractResponseType<ReturnType<T[K]>>;

interface ReturnPayload<T extends Record<K, (...args: any[]) => any>, K extends keyof T, J extends boolean> {
  loading: Ref<boolean>,
  data: ComputedRef<ReturnData<T, K, J>>;
}

interface OfflineParams<T extends Record<K, (...args: any[]) => any>, K extends keyof T> {
  api: ((api: Api) => T);
  methodName: K;
  args: Parameters<T[K]>;
}

/**
 * Perfoms the given request and updates the store accordingly
 *
 * @param api - Relevant API
 * @param methodName - Method to execute
 * @param ofBaseItem - Whether the request is BaseItemDto based or not
 * @param loading - Ref to hold the loading state
 * @param args - Func args
 */
async function resolveAndAdd<T extends Record<K, (...args: any[]) => any>, K extends keyof T>(
  api: ((api: Api) => T),
  methodName: K,
  ofBaseItem: boolean,
  loading: Ref<boolean>,
  stringifiedArgs: string,
  skipCache: boolean,
  ...args: Parameters<T[K]>): Promise<void> {
  /**
   * We add all BaseItemDto's fields for consistency in what we can expect from the store.
   * toValue normalizes the getters.
   */
  const extendedParams = [
    {
      ...args[0],
      ...(remote.auth.currentUserId && { userId: remote.auth.currentUserId }),
      fields: apiStore.apiEnums.fields,
      enabledImageTypes: apiStore.apiEnums.images,
      enableImages: true,
      enableTotalRecordCount: false
    },
    ...args.slice(1)
  ] as Parameters<T[K]>;

  try {
    loading.value = true;

    const funcName = `${api.name}.${String(methodName)}`;
    const response = await remote.sdk.newUserApi(api)[methodName](...extendedParams) as Awaited<ReturnType<T[K]>>;

    if (response.data) {
      const requestData = response.data as Awaited<ReturnType<T[K]>['data']>;
      const result = 'Items' in requestData && Array.isArray(requestData.Items) ? requestData.Items : requestData;

      if (ofBaseItem && !skipCache) {
        apiStore.baseItemAdd(result as BaseItemDto | BaseItemDto[]);
      }

      if (!skipCache) {
        apiStore.requestAdd(funcName, stringifiedArgs, ofBaseItem, result);
      }
    }
  } catch {} finally {
    loading.value = false;
  }
}

/**
 * This is the internal logic of the composables
 */
function _sharedInternalLogic<T extends Record<K, (...args: any[]) => any>, K extends keyof T, U extends ParametersAsGetters<T[K]>>(
  ofBaseItem: boolean,
  api: MaybeRef<((api: Api) => T) | undefined>,
  methodName: MaybeRef<K | undefined>,
  skipCache: MaybeRef<boolean> = false
): (this: any, ...args: ComposableParams<T,K,U>) => Promise<ReturnPayload<T, K, typeof ofBaseItem>> | ReturnPayload<T, K, typeof ofBaseItem> {
  const offlineParams: OfflineParams<T,K>[] = [];
  const isFuncDefined = (): boolean => unref(api) !== undefined && unref(methodName) !== undefined;

  const loading = ref(false);
  const argsRef = ref<Parameters<T[K]>>();

  const stringArgs = computed(() => {
    return JSON.stringify(argsRef.value);
  });
  const cachedData = computed(() => apiStore.getCachedRequest(`${String(unref(api)?.name)}.${String(unref(methodName))}`, stringArgs.value));
  const isCached = computed(() => Boolean(cachedData.value));
  const data = computed<ReturnData<T, K, typeof ofBaseItem>>(() =>
    apiStore.getRequest(cachedData.value) as ReturnData<T, K, typeof ofBaseItem>
  );

  /**
   * Function invoked per every data change.
   * @param onlyPending - Whether to run only pending requests or not
   */
  const run = async (onlyPending = false): Promise<void> => {
    const unrefApi = unref(api);
    const unrefMethod = unref(methodName);

    if (unrefApi && unrefMethod) {
      /**
       * Rerun previous parameters when the user is back online
       */
      if (offlineParams.length > 0) {
        await Promise.all(offlineParams.map((p) => {
          void resolveAndAdd(p.api, p.methodName, ofBaseItem, loading, stringArgs.value, unref(skipCache), ...p.args);
        }));

      }

      if (argsRef.value && !onlyPending) {
        try {
          if (network.isOnline.value && remote.socket.isConnected) {
            await resolveAndAdd(unrefApi, unrefMethod, ofBaseItem, loading, stringArgs.value, unref(skipCache), ...argsRef.value);
          } else {
            useSnackbar(i18n.t('offlineCantDoThisWillRetryWhenOnline'), 'error');

            offlineParams.push({
              api: unrefApi,
              methodName: unrefMethod,
              args: argsRef.value
            });
          }
        } catch {}
      }
    }
  };

  return function (this: any, ...args: ComposableParams<T,K,U>) {
    const setArgs = (): void => {
      argsRef.value = args.map((a) => toValue(a)) as Parameters<T[K]>;
    };

    setArgs();

    if (getCurrentScope() !== undefined) {
      watch(args, async (_newVal, oldVal) => {
        /**
         * Does a deep comparison to avoid useless double requests
         */
        if (!args.map((a) => toValue(a)).every((a, index) => isEqual(a, toValue(oldVal?.[index])))) {
          setArgs();
          await run();
        }
      });
      watch(() => remote.socket.isConnected, async () => await run(true));
      watch(network.isOnline, async () => await run(true));
      isRef(api) && watch(api, async () => await run());
      isRef(methodName) && watch(methodName, async () => await run());
      isRef(skipCache) && watch(skipCache, async () => await run());
    }

    /**
     * If there's available data before component mount, we return the cached data rightaway (see below how
     * we skip the promise) to get the component mounted as soon as possible.
     * However, we queue a request to the server to update the data after the component is
     * mounted. setTimeout executes it when the event loop is clear, avoiding overwhelming the engine.
     */
    isCached.value && window.setTimeout(async () => {
      await run();
    });

    if (!isCached.value && isFuncDefined()) {
      const scope = effectScope();

      /**
       * Wait for the cache to be populated before resolving the promise
       * If the promise never resolves (and the component never gets mounted),
       * the problem is that there is an issue in your logic, not in this composable.
       */
      // eslint-disable-next-line no-async-promise-executor
      return new Promise(async (resolve) => {
        await run();
        scope.run(() => {
          watch(isCached, () => {
            if (isCached.value && !skipCache) {
              scope.stop();
              resolve({ loading, data });
            }
          }, { immediate: true, flush: 'sync' });
        });
      });
    }

    return { loading, data };
  };
}

/**
 * Reactively performs item requests to the API:
 *
 * - When the parameters of the request changes, the request is performed again and the ComputedRef returns updated data
 * - Caches the request response in the apiStore
 * - If there's already cached data in the store for the given parameters, a request to the
 * server it's still performed to refresh, but the Promise will be resolved
 * immediately and the ComputedRef will return the cached data first.
 * - If the request is made when the connection to the server was lost, the request and their params are queued and executed when the connection is back.
 *
 * This composable also returns a promise, so it prevents rendering the component with Suspense until the initial request is done
 * (ensuring this way the data is always available before mount).
 * See [Vue docs](https://vuejs.org/guide/built-ins/suspense.html#suspense) for more information.
 *
 * Here's an usage example. **Request parameters must be passed as getters (like props on watchers)**:
 *
 * ```ts
 * const { loading, data: item } = await useBaseItem(getUserLibraryApi, 'getItem')(() => {
 *   ...the request parameters
 * });
 * ```
 *
 * Caveats:
 * - If not used inside a component's script setup area (or in any Vue's effectScope), changing parameters will not be reactive.
 * This is done in order to avoid memory leaks.
 * - It only works with requests that return BaseItemDto or BaseItemDtoQueryResult responses. If you need to use another type, you **must**
 * use the `useApi` composable.
 * - **BE CAREFUL**: Since the type of the ComputedRef's of data is always the request's response,
 * if no succesful response data is available at any point, the promise will never resolve to ensure at runtime the expected data is available.
 * This means that the component might never mount if you use it to fetch the initial page data.
 * This forces you to have the correct logic and successful responses in normal conditions.
 * If the user has lost the internet connection, for example, it won't be redirected to the new page's component,
 * since it will never mount, and that's what we want! (so the user can only navigate data he has already acquired).
 * This will not happen if either ``api`` or ``methodName`` are set undefined, so
 * you can use that composable invokation after mount (like in LikeButton component).
 *
 * Don't worry, TypeScript will tell you that `data` is always undefined when you can't use the composable with an specific API method.
 *
 * @param api - The API's endpoint to use.
 * @param methodname- - The operation to execute.
 * @returns data  - The BaseItemDto or BaseItemDto[] that was requested.
 * @returns loading - A boolean ref that indicates if the request is in progress.
 */
export function useBaseItem<T extends Record<K, (...args: any[]) => any>, K extends keyof T, U extends ParametersAsGetters<T[K]>>(
  api: MaybeRef<((api: Api) => T) | undefined>,
  methodName: MaybeRef<K | undefined>
): (this: any, ...args: ComposableParams<T,K,U>) => Promise<ReturnPayload<T, K, true>> | ReturnPayload<T, K, true> {
  return _sharedInternalLogic<T, K, U>(true, api, methodName);
}

/**
 * Reactively performs requests to the API:
 *
 * - When the parameters of the request changes, the request is performed again and the ComputedRef returns updated data.
 * - Caches the request response in the apiStore
 * - If there's already cached data in the store for the given parameters, a request to the
 * server it's still performed to refresh, but the Promise will be resolved
 * immediately and the ComputedRef will return the cached data first.
 * - If the request is made when the connection to the server was lost, the request and their params are queued and executed when the connection is back.
 *
 * This composable also returns a promise, so it prevents rendering the component with Suspense until the initial request is done
 * (ensuring this way the data is always available before mount).
 * See [Vue docs](https://vuejs.org/guide/built-ins/suspense.html#suspense) for more information.
 *
 * Here's an usage example. **Request parameters must be passed as getters (like props on watchers)**.:
 *
 * ```ts
 * const { loading, data: item } = await useApi(getItemUpdateApi, 'updateItemContentType')(() => {
 *   ...the request parameters
 * });
 * ```
 *
 * Caveats:
 * - If not used inside a component's script setup area (or in any Vue's effectScope), changing parameters will not be reactive.
 * This is done in order to avoid memory leaks.
 * - It only works with requests that doesn't return BaseItemDto or BaseItemDtoQueryResult responses. If the return result
 * of your request is any of those types, you **must** use the `useBaseItem` composable.
 * - **BE CAREFUL**: Since the type of the ComputedRef's of data is always the request's response,
 * if no succesful response data is available at any point (**and skipCache = false**),
 * the promise will never resolve to ensure at runtime the expected data is available.
 * This means that the component might never mount if you use it to fetch the initial page data.
 * This forces you to have the correct logic and successful responses in normal conditions.
 * If the user has lost the internet connection, for example, it won't be redirected to the new page's component,
 * since it will never mount, and that's what we want! (so the user can only navigate data he has already acquired).
 * This will not happen if either ``api`` or ``methodName`` are set undefined, so
 * you can use that composable invokation after mount (like in LikeButton component).
 *
 * Don't worry, TypeScript will tell you that `data` is always undefined when you can't use the composable with an specific API method.
 *
 * @param api - The API's endpoint to use.
 * @param methodname- - The operation to execute.
 * @param skipCache - USE WITH CAUTION, SINCE IT'S BETTER TO CACHE EVERYTHING BY DEFAULT. Defaults to false.
 * Whether to skip the cache or not. Useful for requests whose return value are known to be useless to cache,
 * like marking an item as played or favorite.
 * @returns data  - The request data.
 * @returns loading - A boolean ref that indicates if the request is in progress.
 */
export function useApi<T extends Record<K, (...args: any[]) => any>, K extends keyof T, U extends ParametersAsGetters<T[K]>>(
  api: MaybeRef<((api: Api) => T) | undefined>,
  methodName: MaybeRef<K | undefined>,
  skipCache: MaybeRef<boolean> = false
): (this: any, ...args: ComposableParams<T,K,U>) => Promise<ReturnPayload<T, K, false>> | ReturnPayload<T, K, false> {
  return _sharedInternalLogic<T, K, U>(false, api, methodName, skipCache);
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */