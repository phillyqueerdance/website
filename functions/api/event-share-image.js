import { shareImageHandler } from '../share-image-handler.js';
import { renderShareImage } from '../share-image-renderer.js';

export const onRequestGet = shareImageHandler(renderShareImage);
