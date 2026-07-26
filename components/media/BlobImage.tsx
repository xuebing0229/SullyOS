import React, { useEffect, useState } from 'react';
import { useBlobRefUrl } from '../../utils/blobRef';

export interface BlobImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
    src?: string | null;
    fallback?: React.ReactNode;
}

const DefaultFallback: React.FC = () => (
    <div className="flex items-center justify-center min-h-24 min-w-24 rounded-xl bg-slate-100 text-[11px] text-slate-400">
        图片已丢失
    </div>
);

const BlobImage: React.FC<BlobImageProps> = ({ src, fallback, onError, ...imgProps }) => {
    const resolvedUrl = useBlobRefUrl(src);
    const [failed, setFailed] = useState(false);
    useEffect(() => { setFailed(false); }, [src, resolvedUrl]);
    if (!resolvedUrl || failed) return <>{fallback ?? <DefaultFallback />}</>;
    return <img {...imgProps} src={resolvedUrl} onError={(event) => { setFailed(true); onError?.(event); }} />;
};

export default BlobImage;
