import { getAppMode } from '../lib/app-mode';
import './style.css';
import './trades.css';
export const metadata={title:'XAUTUSD Delta Live Algo'};
export default function Layout({children}:{children:React.ReactNode}){getAppMode();return <html><body>{children}</body></html>}
