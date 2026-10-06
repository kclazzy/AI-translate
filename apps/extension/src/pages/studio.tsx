import { createRoot } from 'react-dom/client';
import { StudioApp, type View } from '@ait/studio';
import '@ait/studio/styles.css';
import { extensionPlatform } from './platform';

const params = new URLSearchParams(location.search);
const key = params.get('key') ?? undefined;
const view = (params.get('view') as View | null) ?? undefined;

createRoot(document.getElementById('root')!).render(<StudioApp platform={extensionPlatform()} resultKey={key} initialView={view} />);
