export interface NameGeneratorProps {
    shared?: boolean;
    infix?: string;
    overrides?: {
      tenant?: string;
      stage?: string;
    };
  }
  