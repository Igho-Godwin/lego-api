import { Injectable, Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { LegoBox } from '../../entities/lego-box.entity';
import { ComponentNotFoundException } from 'src/common/exceptions/custom-exceptions';
import { LegoPiece } from 'src/lego-box/entities/lego-piece.entity';
import { LegoBoxComponent } from '../../entities/lego-box-component.entity';
import { BatchLegoBoxPriceUpdateProducer } from '../lego-box-price-batch-update/batch-price-update-producer';
import { LegoBoxService } from 'src/lego-box/lego-box.service';
import {
  BatchBoxDto,
  BatchComponentDto,
} from 'src/lego-box/dtos/batch-import.dto';
import { Transaction } from 'src/lego-box/entities/transaction.entity';
import { TransactionBox } from 'src/lego-box/entities/transaction-box.entity';

@Injectable()
export class BatchLegoBoxComponentUpdateService {
  private readonly logger = new Logger(BatchLegoBoxComponentUpdateService.name);

  constructor(
    private readonly batchLegoBoxPriceUpdateProducer: BatchLegoBoxPriceUpdateProducer,
    private readonly legoBoxService: LegoBoxService,
  ) {}

  async processData(
    boxImport: BatchBoxDto,
    queryRunner: QueryRunner,
  ): Promise<void> {
    try {
      this.logger.debug(`Processing component for box: ${boxImport.name}`);

      // Find or create lego box
      let legoBox = await queryRunner.manager.findOne(LegoBox, {
        where: { name: boxImport.name },
      });

      if (!legoBox) {
        this.logger.debug(`Creating new box: ${boxImport.name}`);
        legoBox = queryRunner.manager.create(LegoBox, {
          name: boxImport.name,
          price: 0,
        });
        legoBox = await queryRunner.manager.save(LegoBox, legoBox);
      }

      if (!legoBox.id) {
        throw new Error(`Failed to create/find box: ${boxImport.name}`);
      }

      for (const component of boxImport.components) {
        // Process based on component type
        if (component.component_type === 'piece') {
          await this.processPieceComponent(queryRunner, legoBox, component);
        } else {
          await this.processBoxComponent(queryRunner, legoBox, component);
        }
      }

      const newBox = await queryRunner.manager.findOne(LegoBox, {
        where: { id: legoBox.id },
      });
      this.updateTransaction(queryRunner, newBox, boxImport.amount);
      await this.batchLegoBoxPriceUpdateProducer.queueBatchImport(newBox);
      this.legoBoxService.invalidateTransactionHistoryCache(newBox.id);
    } catch (err) {
      this.logger.error(`Error processing data: ${err.message}`, err.stack);
      throw err;
    }
  }

  private async processPieceComponent(
    queryRunner: QueryRunner,
    legoBox: LegoBox,
    singleComponentImport: BatchComponentDto,
  ): Promise<void> {
    this.logger.debug(
      `Processing piece component ${singleComponentImport.component_id} for box ${legoBox.name}`,
    );

    const piece = await queryRunner.manager.findOne(LegoPiece, {
      where: { id: singleComponentImport.component_id },
    });

    if (!piece) {
      throw new ComponentNotFoundException(singleComponentImport.component_id);
    }

    const legoBoxComponent = queryRunner.manager.create(LegoBoxComponent, {
      parent_box_id: legoBox.id,
      component_type: 'piece',
      lego_piece_component_id: piece.id,
    });

    await queryRunner.manager.save(LegoBoxComponent, legoBoxComponent);

    // Update box price
    const updatedPrice = Number(legoBox.price) + Number(piece.price);
    await queryRunner.manager.update(
      LegoBox,
      { id: legoBox.id },
      { price: Number(updatedPrice.toFixed(2)) },
    );
  }

  private async processBoxComponent(
    queryRunner: QueryRunner,
    legoBox: LegoBox,
    singleComponentImport: BatchComponentDto,
  ): Promise<void> {
    this.logger.debug(
      `Processing box component ${singleComponentImport.component_id} for box ${legoBox.name}`,
    );

    const childBox = await queryRunner.manager.findOne(LegoBox, {
      where: { id: singleComponentImport.component_id },
      relations: ['components'],
    });

    if (!childBox) {
      throw new ComponentNotFoundException(singleComponentImport.component_id);
    }

    // Check for circular reference
    if (childBox.id === legoBox.id) {
      throw new Error(
        'Circular reference detected: A box cannot contain itself',
      );
    }

    const existingBox = childBox.components.find(
      (boxTemp) => boxTemp.lego_box_component_id === legoBox.id,
    );

    if (existingBox) {
      throw new Error(
        `box id ${legoBox.id}  already in box ${existingBox.parent_box_id}`,
      );
    }

    const legoBoxComponent = queryRunner.manager.create(LegoBoxComponent, {
      parent_box_id: legoBox.id,
      component_type: 'box',
      lego_box_component_id: childBox.id,
    });

    await queryRunner.manager.save(LegoBoxComponent, legoBoxComponent);

    // Update box price
    const updatedPrice = Number(legoBox.price) + Number(childBox.price);
    await queryRunner.manager.update(
      LegoBox,
      { id: legoBox.id },
      { price: Number(updatedPrice.toFixed(2)) },
    );
  }

  private async updateTransaction(
    queryRunner: QueryRunner,
    legoBox: LegoBox,
    amount: number,
  ): Promise<void> {
    let transaction: Transaction;
    const transactionBox = await queryRunner.manager.findOne(TransactionBox, {
      where: { lego_box_id: legoBox.id },
    });

    if (!transactionBox) {
      // Create new transaction
      transaction = await queryRunner.manager.save(Transaction, {
        total_price: Number((legoBox.price * amount).toFixed(2)),
      });

      await queryRunner.manager.save(TransactionBox, {
        transaction_id: transaction.id,
        lego_box_id: legoBox.id,
        amount,
      });
    } else {
      // Update existing transaction
      transaction = await queryRunner.manager.findOne(Transaction, {
        where: { id: transactionBox.transaction_id },
      });

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      transaction.total_price = Number(
        (
          Number(legoBox.price * amount) + Number(transaction.total_price)
        ).toFixed(2),
      );

      await queryRunner.manager.save(transaction);

      await queryRunner.manager.save(TransactionBox, {
        transaction_id: transaction.id,
        lego_box_id: legoBox.id,
        amount,
      });
    }
  }
}
