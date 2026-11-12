import { authenticateRequest } from "@/lib/auth-request";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { imageFileResponse } from "@/lib/recordings/image-response";
import { getReadyImage } from "@/lib/recordings/images";
import {
    enforceV1AuthenticatedRateLimit,
    enforceV1IpRateLimit,
} from "@/lib/v1/rate-limit";

type ImageContext = { params: Promise<{ id: string; imageId: string }> };

export const GET = apiHandler<ImageContext>(async (request, context) => {
    const ipLimitResponse = await enforceV1IpRateLimit(request);
    if (ipLimitResponse) return ipLimitResponse;

    const authn = await authenticateRequest(request);
    if (!authn) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401);
    }

    const authLimitResponse = await enforceV1AuthenticatedRateLimit(authn);
    if (authLimitResponse) return authLimitResponse;

    const { id, imageId } = await (context as ImageContext).params;
    const image = await getReadyImage(authn.user.id, id, imageId);
    if (!image) {
        throw new AppError(ErrorCode.NOT_FOUND, "Photo not found", 404, {
            id,
            imageId,
        });
    }
    return imageFileResponse(authn.user.id, image);
});
