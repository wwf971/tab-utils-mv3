// Public connection defaults embedded by popup/vite.config.ts at build time
// from backend-aws/config_gen.yaml. They are not credentials: the user still
// authenticates with Cognito, and may override or clear every value.

export interface RemoteAwsBuildDefaults {
  endpointUrl: string
  region: string
  clientId: string
}

declare const __TAB_CLOUD_AWS_DEFAULTS__: RemoteAwsBuildDefaults

export const remoteAwsBuildDefaults = __TAB_CLOUD_AWS_DEFAULTS__

export const hasRemoteAwsBuildDefaults = (
  remoteAwsBuildDefaults.endpointUrl !== ''
  && remoteAwsBuildDefaults.region !== ''
  && remoteAwsBuildDefaults.clientId !== ''
)
