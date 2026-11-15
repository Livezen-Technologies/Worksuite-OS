// Errors the service returns over D-Bus as lk.worksuite.Error.<code>.
export type SetupErrorCode = 'InvalidArgs' | 'NotAuthorized' | 'Refused' | 'Failed' | 'Unsupported'

export class SetupError extends Error {
  readonly code: SetupErrorCode
  constructor(code: SetupErrorCode, message: string = code) { super(message); this.code = code }
}
