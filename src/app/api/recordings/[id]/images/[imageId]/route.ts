import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { imageFileResponse } from "@/lib/recordings/image-response";
import { getReadyImage } from "@/lib/recordings/images";

type ImageContext = { params: Promise<{ id: string; imageId: string }> };

/** One stored Plaud photo of the signed-in user's recording (#331). */
export const GET = apiHandler<ImageContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, imageId } = await (context as ImageContext).params;
    const image = await getReadyImage(session.user.id, id, imageId);
    if (!image) {
        throw new AppError(ErrorCode.NOT_FOUND, "Photo not found", 404);
    }
    return imageFileResponse(session.user.id, image);
});
