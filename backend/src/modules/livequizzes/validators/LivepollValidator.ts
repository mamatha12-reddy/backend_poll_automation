import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

export class CreateInMemoryPollDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  options: string[];

  @IsInt()
  @Min(0)
  correctOptionIndex: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  timer?: number;
}

export class SubmitInMemoryAnswerDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsInt()
  @Min(0)
  answerIndex: number;
}
