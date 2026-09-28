declare module '*.css?url' {
  const href: string
  export default href
}

declare module '@xterm/addon-ligatures/lib/addon-ligatures.mjs' {
  export { LigaturesAddon } from '@xterm/addon-ligatures'
}

declare module '@aws-sdk/client-s3' {
  import { Client, Command } from '@smithy/smithy-client'
  import type {
    InvokeFunction,
    MetadataBearer,
    MiddlewareStack,
    OperationSchema,
    StaticOperationSchema,
  } from '@smithy/types'

  type S3CommandInput = Record<string, unknown>
  type S3CommandOutput = MetadataBearer

  export type S3ClientConfig = {
    credentials?: {
      accessKeyId: string
      secretAccessKey: string
    }
    endpoint?: string
    forcePathStyle?: boolean
    region?: string
  }

  export class S3Client extends Client<any, S3CommandInput, S3CommandOutput, any> {
    readonly config: any
    middlewareStack: MiddlewareStack<S3CommandInput, S3CommandOutput>
    send: InvokeFunction<S3CommandInput, S3CommandOutput, any>
    destroy: () => void

    constructor(config?: S3ClientConfig)
  }

  export type GetObjectCommandInput = {
    Bucket?: string
    Key?: string
  }

  export class GetObjectCommand extends Command<
    GetObjectCommandInput,
    S3CommandOutput,
    any,
    S3CommandInput,
    S3CommandOutput
  > {
    input: GetObjectCommandInput
    readonly middlewareStack: MiddlewareStack<GetObjectCommandInput, S3CommandOutput>
    readonly schema?: OperationSchema | StaticOperationSchema
    resolveMiddleware: (...args: any[]) => any
    resolveMiddlewareWithContext: (...args: any[]) => any

    constructor(input: GetObjectCommandInput)
  }

  export type ListObjectsV2CommandInput = {
    Bucket?: string
    MaxKeys?: number
  }

  export class ListObjectsV2Command extends Command<
    ListObjectsV2CommandInput,
    S3CommandOutput,
    any,
    S3CommandInput,
    S3CommandOutput
  > {
    input: ListObjectsV2CommandInput
    readonly middlewareStack: MiddlewareStack<ListObjectsV2CommandInput, S3CommandOutput>
    readonly schema?: OperationSchema | StaticOperationSchema
    resolveMiddleware: (...args: any[]) => any
    resolveMiddlewareWithContext: (...args: any[]) => any

    constructor(input: ListObjectsV2CommandInput)
  }
}

declare module '@xterm/xterm' {
  export type ITerminalAddon = {
    activate?: (terminal: Terminal) => void
    dispose?: () => void
  }

  export type IDisposable = {
    dispose: () => void
  }

  export type ITerminalOptions = {
    allowProposedApi?: boolean
    allowTransparency?: boolean
    cursorBlink?: boolean
    fontFamily?: string
    fontSize?: number
    scrollback?: number
    theme?: Record<string, string>
  }

  export class Terminal {
    constructor(options?: ITerminalOptions)

    readonly cols: number
    readonly rows: number
    readonly unicode: { activeVersion: string }
    options: ITerminalOptions

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
    clear(): void
    dispose(): void
    focus(): void
    getSelection(): string
    loadAddon(addon: ITerminalAddon): void
    onData(callback: (data: string) => void): IDisposable
    onSelectionChange(callback: () => void): IDisposable
    open(parent: HTMLElement): void
    paste(data: string): void
    refresh(start: number, end: number): void
    reset(): void
    write(data: string): void
  }
}

declare module 'echarts' {
  export type EChartsSetOptionOptions = {
    notMerge?: boolean
    lazyUpdate?: boolean
  }

  export type EChartsInstance = {
    setOption: (option: unknown, options?: EChartsSetOptionOptions) => void
    resize: () => void
    dispose: () => void
  }

  export const init: (
    element: HTMLElement,
    theme?: string | Record<string, unknown>,
    options?: { renderer?: 'canvas' | 'svg' },
  ) => EChartsInstance
}

declare module 'recharts' {
  import type { ComponentType, ReactNode } from 'react'
  import type { Props as DefaultLegendContentProps } from 'recharts/types/component/DefaultLegendContent'
  import type { TooltipProps } from 'recharts/types/component/Tooltip'

  export type { Props as DefaultLegendContentProps } from 'recharts/types/component/DefaultLegendContent'
  export type { TooltipContentProps, TooltipProps } from 'recharts/types/component/Tooltip'

  type RechartsComponentProps = {
    children?: ReactNode
    [key: string]: unknown
  }

  export const Bar: ComponentType<RechartsComponentProps>
  export const BarChart: ComponentType<RechartsComponentProps>
  export const CartesianGrid: ComponentType<RechartsComponentProps>
  export const DefaultLegendContent: ComponentType<DefaultLegendContentProps>
  export const Legend: ComponentType<DefaultLegendContentProps & RechartsComponentProps>
  export const Line: ComponentType<RechartsComponentProps>
  export const LineChart: ComponentType<RechartsComponentProps>
  export const ResponsiveContainer: ComponentType<RechartsComponentProps>
  export const Tooltip: ComponentType<TooltipProps & RechartsComponentProps>
  export const XAxis: ComponentType<RechartsComponentProps>
  export const YAxis: ComponentType<RechartsComponentProps>
}

type JangarServerRouteArgs = {
  request: Request
  params: Record<string, string>
}

type JangarServerRouteArgsWith<TParams extends Record<string, string>> = {
  request: Request
  params: TParams
}

type JangarServerRouteHandler = (args: JangarServerRouteArgs) => Response | Promise<Response>

type JangarServerRouteHandlers = Partial<Record<'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT', JangarServerRouteHandler>>

type JangarGithubPullRouteParams = {
  owner: string
  repo: string
  number: string
}

type JangarGithubPullThreadRouteParams = JangarGithubPullRouteParams & {
  threadId: string
}

declare module '@tanstack/router-core' {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends import('@tanstack/router-core').AnyRoute = import('@tanstack/router-core').AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = import('@tanstack/router-core').AnyContext,
    TBeforeLoadFn = import('@tanstack/router-core').AnyContext,
    TRemountDepsFn = import('@tanstack/router-core').AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: {
      handlers?: JangarServerRouteHandlers
    }
  }
}

declare module '@tanstack/router-core/dist/esm/route' {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends import('@tanstack/router-core').AnyRoute = import('@tanstack/router-core').AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = import('@tanstack/router-core').AnyContext,
    TBeforeLoadFn = import('@tanstack/router-core').AnyContext,
    TRemountDepsFn = import('@tanstack/router-core').AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: {
      handlers?: JangarServerRouteHandlers
    }
  }
}

declare module '@tanstack/router-core/dist/esm/route.js' {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends import('@tanstack/router-core').AnyRoute = import('@tanstack/router-core').AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = import('@tanstack/router-core').AnyContext,
    TBeforeLoadFn = import('@tanstack/router-core').AnyContext,
    TRemountDepsFn = import('@tanstack/router-core').AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: {
      handlers?: JangarServerRouteHandlers
    }
  }
}
