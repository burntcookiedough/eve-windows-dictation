import { app } from 'electron';
import { bootstrapApplication } from './bootstrap-core.js';

await bootstrapApplication(app, () => import('./index.js'));
