import React, { createContext, useContext } from 'react';

export interface Branding {
  name: string;
  shortName: string;
  logo?: string;
  logoVersion?: number;
  accentColor?: string;
  tagline?: string;
}

const defaultBranding: Branding = { name: 'AgentHub', shortName: 'AH' };
const BrandingContext = createContext<Branding>(defaultBranding);

export const BrandingProvider: React.FC<{ branding?: Partial<Branding>; children: React.ReactNode }> = ({ branding, children }) => (
  <BrandingContext.Provider value={{ ...defaultBranding, ...branding }}>{children}</BrandingContext.Provider>
);

export function useBranding(): Branding {
  return useContext(BrandingContext);
}
