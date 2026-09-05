// Direct AWS Cognito user-pool auth of the aws backend: the popup talks to
// the cognito-idp endpoint itself (no aws sdk), using the app client created
// by backend-aws/ensure_architect.py. Login uses the USER_PASSWORD_AUTH flow;
// the returned refresh token is kept in extension storage so the session
// survives popup and browser restarts, and access tokens are renewed silently
// with REFRESH_TOKEN_AUTH. Refer to aws_backend_impl.md#login-and-session.
//
// Same result convention as RemoteApi: {code, data?, message}, code 0 = ok.

import { type RemoteResult } from './RemoteApi'

export interface CognitoTokens {
  accessToken: string
  // empty on refresh responses: cognito keeps the existing refresh token
  refreshToken: string
  expireAtMs: number
}

const cognitoTimeoutMs = 10000
const codeAuthFail = -2

export async function cognitoLogin(
  region: string,
  clientId: string,
  username: string,
  password: string
): Promise<RemoteResult<CognitoTokens>> {
  return cognitoAuthRun(region, {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: username, PASSWORD: password }
  })
}

export async function cognitoRefresh(
  region: string,
  clientId: string,
  refreshToken: string
): Promise<RemoteResult<CognitoTokens>> {
  return cognitoAuthRun(region, {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken }
  })
}

async function cognitoAuthRun(
  region: string,
  body: Record<string, unknown>
): Promise<RemoteResult<CognitoTokens>> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), cognitoTimeoutMs)
  try {
    const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const result = await response.json() as {
      AuthenticationResult?: {
        AccessToken?: string
        RefreshToken?: string
        ExpiresIn?: number
      }
      ChallengeName?: string
      __type?: string
      message?: string
    }
    if (result.ChallengeName) {
      // e.g. NEW_PASSWORD_REQUIRED for a user still on the temporary password
      return {
        code: codeAuthFail,
        message: `Cognito requires ${result.ChallengeName}; finish the account`
          + ' setup once through the aws_oa hosted login page'
      }
    }
    const auth = result.AuthenticationResult
    if (!response.ok || !auth?.AccessToken) {
      return {
        code: codeAuthFail,
        message: result.message || result.__type || 'Cognito login failed'
      }
    }
    return {
      code: 0,
      data: {
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken ?? '',
        expireAtMs: Date.now() + (auth.ExpiresIn ?? 3600) * 1000
      }
    }
  } catch (error) {
    const messageText = error instanceof Error && error.name === 'AbortError'
      ? 'Cognito request timed out'
      : `Cognito unreachable: ${error instanceof Error ? error.message : String(error)}`
    return { code: codeAuthFail, message: messageText }
  } finally {
    clearTimeout(timeoutId)
  }
}
