type SagServerRouteArgs = {
  request: Request
  params: Record<string, string>
}

type SagServerRouteArgsWith<TParams extends Record<string, string>> = {
  request: Request
  params: TParams
}
