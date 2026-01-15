import { z } from "zod";
import { ProjectIdSchema } from "./base.js";

export const RegisterSessionSchema = z.object({
    projectId: ProjectIdSchema
});
