import { Environment } from '../../dtos/environment';

export class StackNamingUtil {
    static createResourceName(
      projectName: string, 
      environment: Environment, 
      resourceType: string, 
      suffix?: string
    ): string {
      // Create a consistent naming pattern
      const nameParts = [
        projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        environment.toLowerCase(),
        resourceType.toLowerCase(),
        suffix?.toLowerCase()
      ].filter(Boolean); // Remove undefined parts
  
      return nameParts.join('-').substring(0, 64); // Respect AWS naming constraints
    }
  }