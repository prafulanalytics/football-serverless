export class EventNameGenerator {
    /**
     * Generate a structured partition key (PK) for DynamoDB
     * @param season - The season identifier
     * @param matchId - The match ID
     * @returns A partition key in the format: `SEASON#<season>#MATCH#<matchId>`
     */
    public generatePartitionKey(season: string | number, matchId: string | number): string {
      return `SEASON#${season}#MATCH#${matchId}`;
    }
  
    /**
     * Generate a structured sort key (SK) for DynamoDB
     * @param prefix - The type of entity (e.g., "EVENT", "PLAYER", "TEAM")
     * @param uniqueId - A unique identifier for sorting (e.g., timestamp, UUID)
     * @returns A sort key in the format: `<prefix>#<uniqueId>`
     */
    public generateSortKey(prefix: string, uniqueId: string | number): string {
      return `${prefix}#${uniqueId}`;
    }
  }