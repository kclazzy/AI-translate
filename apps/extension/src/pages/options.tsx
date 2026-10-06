import { createRoot } from 'react-dom/client';
import { StudioApp } from '@ait/studio';
import '@ait/studio/styles.css';
import { extensionPlatform } from './platform';

createRoot(document.getElementById('root')!).render(<StudioApp platform={extensionPlatform()} initialView="settings" />);
