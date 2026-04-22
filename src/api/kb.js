import { apiFetch } from './client';

export const fetchHealth    = () => apiFetch('/health').then(r => r.json());
export const fetchStats     = () => apiFetch('/stats').then(r => r.json());
export const fetchDocuments = () => apiFetch('/documents').then(r => r.json());