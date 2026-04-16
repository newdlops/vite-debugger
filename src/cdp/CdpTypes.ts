// CDP type definitions for the domains we use
// These are self-contained to avoid dependency on chrome-remote-interface's types

export interface Location {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: Location;
  url: string;
  scopeChain: Scope[];
  this: RemoteObject;
}

export interface Scope {
  type: string;
  object: RemoteObject;
  name?: string;
  startLocation?: Location;
  endLocation?: Location;
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: PropertyPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  value?: string;
  subtype?: string;
}

export interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  writable?: boolean;
  get?: RemoteObject;
  set?: RemoteObject;
  configurable?: boolean;
  enumerable?: boolean;
  isOwn?: boolean;
}

export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string;
  url?: string;
  exception?: RemoteObject;
}

export interface CallArgument {
  value?: unknown;
  objectId?: string;
  unserializableValue?: string;
}

export interface BreakLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
  type?: string;  // 'debuggerStatement' | 'call' | 'return'
}

export interface FetchRequestPausedEvent {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  frameId: string;
  resourceType: string;
  networkId?: string;
}

export interface RequestPattern {
  urlPattern?: string;
  resourceType?: string;
  requestStage?: 'Request' | 'Response';
}

export interface ConsoleAPICalledEvent {
  type: string;  // 'log' | 'warn' | 'error' | 'info' | 'debug' | 'dir' | 'table' | 'trace' | 'clear'
  args: RemoteObject[];
  executionContextId: number;
  timestamp: number;
  stackTrace?: { callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> };
}
