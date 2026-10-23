import { validateShape } from '../annotations/geometry.js';
import { fail } from './common.js';

export function polyline(coordinates, image) {
    if (!Array.isArray(coordinates) || coordinates.length < 4 || coordinates.length > 258 || coordinates.length % 2) fail('polyline point count is unsupported');
    const points = [];
    for (let offset = 0; offset < coordinates.length; offset += 2) {
        const x = coordinates[offset], y = coordinates[offset + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > image.columns || y > image.rows) fail('graphic lies outside the referenced image');
        if (points.length && points.at(-1).x === x && points.at(-1).y === y) fail('graphic has duplicate consecutive points');
        points.push({ x, y });
    }
    const closed = points[0].x === points.at(-1).x && points[0].y === points.at(-1).y;
    if (closed) validateShape('polygon', points.slice(0, -1), image);
    else if (points.length > 128) fail('polyline point limit exceeded');
    return { type: 'POLYLINE', points, closed };
}
export function axisAlignedEllipse(coordinates, image) {
    if (!Array.isArray(coordinates) || coordinates.length !== 8) fail('simple ellipse requires four axis endpoints');
    const points = Array.from({ length: 4 }, (_, index) => ({ x: coordinates[index * 2], y: coordinates[index * 2 + 1] }));
    if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > image.columns || point.y > image.rows)) fail('ellipse lies outside image bounds');
    const horizontalMajor = points[0].y === points[1].y && points[2].x === points[3].x;
    const verticalMajor = points[0].x === points[1].x && points[2].y === points[3].y;
    const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    if ((!horizontalMajor && !verticalMajor) || !length(points[0], points[1]) || !length(points[2], points[3]) ||
        length(points[0], points[1]) < length(points[2], points[3]) ||
        Math.abs((points[0].x + points[1].x - points[2].x - points[3].x) / 2) > 1e-5 ||
        Math.abs((points[0].y + points[1].y - points[2].y - points[3].y) / 2) > 1e-5) fail('only valid axis-aligned simple ellipses are supported');
    return { type: 'ELLIPSE', points, closed: true, controlPoints: [{ x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y)) },
        { x: Math.max(...points.map(point => point.x)), y: Math.max(...points.map(point => point.y)) }] };
}
