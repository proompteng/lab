import type { ControlPlaneResourceKind } from '../../server/control-plane-primitive-kinds'
import {
  getTypedResourceEffect,
  listTypedResourceEffect,
  patchTypedResourceMetadataEffect,
  postTypedResourceEffect,
  typedResourceResponse,
  type TypedResourceDeps,
} from '../../server/v1/typed-resources'

export const listFixedKindResources = (
  kind: ControlPlaneResourceKind,
  request: Request,
  deps: TypedResourceDeps = {},
) => typedResourceResponse(listTypedResourceEffect(kind, request), deps)

export const getFixedKindResource = (kind: ControlPlaneResourceKind, request: Request, deps: TypedResourceDeps = {}) =>
  typedResourceResponse(getTypedResourceEffect(kind, request), deps)

export const postFixedKindResource = (kind: ControlPlaneResourceKind, request: Request, deps: TypedResourceDeps = {}) =>
  typedResourceResponse(postTypedResourceEffect(kind, request), deps, 201)

export const patchFixedKindResourceMetadata = (
  kind: ControlPlaneResourceKind,
  request: Request,
  deps: TypedResourceDeps = {},
) => typedResourceResponse(patchTypedResourceMetadataEffect(kind, request), deps)
