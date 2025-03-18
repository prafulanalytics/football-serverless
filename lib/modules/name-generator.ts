import { Environment } from "../../dtos/environment";
export class NameGenerator {
    generateName(arg0: string): string {
      throw new Error('Method not implemented.');
    }
    generateResourceName(
      project: string, 
      environment: Environment, 
      resourceType: string, 
      name?: string
    ): string {
      const baseName = [project, environment, resourceType, name]
        .filter(Boolean)
        .join('-')
        .toLowerCase();
      
      return baseName;
    }
  }