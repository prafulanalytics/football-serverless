// Type definitions
export interface ValidationRule {
    field: string;
    validator: (value: any) => boolean;
    message: string;
  }
  
  export interface ValidationResult {
    valid: boolean;
    errors: string[];
  }
  
  export interface RetryOptions {
    retries?: number;
    initialDelay?: number;
    maxDelay?: number;
    factor?: number;
    retryableErrors?: string[];
  }
  
  export interface ErrorResponse {
    status: string;
    message: string;
    code: number;
    request_id: string;
  }
  
  export interface DLQHealthResult {
    status: 'healthy' | 'warning' | 'error';
    isEmpty: boolean;
    messagesAvailable: number;
    messagesInFlight: number;
    timestamp: string;
    error?: string;
  }
  
  // Logger interface to ensure type safety
  export interface Logger {
    debug: (message: string, context?: Record<string, any>) => void;
    info: (message: string, context?: Record<string, any>) => void;
    warn: (message: string, context?: Record<string, any>) => void;
    error: (message: string, context?: Record<string, any>) => void;
  }
  