import { expect } from 'chai';
import { Udi } from '../src/utils/Udi';

describe('Udi', () => {
    it('should initialize correctly with all parameters', () => {
        const udi = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        expect(udi.chainName).to.equal('chia');
        expect(udi.storeId).to.equal('store1');
        expect(udi.rootHash).to.equal('rootHash1');
        expect(udi.resourceKey).to.equal('resourceKey1');
    });

    it('should initialize correctly with optional parameters', () => {
        const udi = new Udi('chia', 'store1');
        expect(udi.chainName).to.equal('chia');
        expect(udi.storeId).to.equal('store1');
        expect(udi.rootHash).to.be.null;
        expect(udi.resourceKey).to.be.null;
    });

    it('should create a new Udi with a different rootHash using fromRootHash', () => {
        const udi = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        const newUdi = udi.fromRootHash('newRootHash');
        expect(newUdi.rootHash).to.equal('newRootHash');
        expect(newUdi.resourceKey).to.equal('resourceKey1');
    });

    it('should create a new Udi with a different resourceKey using fromResourceKey', () => {
        const udi = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        const newUdi = udi.fromResourceKey('newResourceKey');
        expect(newUdi.resourceKey).to.equal('newResourceKey');
        expect(newUdi.rootHash).to.equal('rootHash1');
    });

    it('should create a Udi from a valid URN', () => {
        const urn = 'urn:dig:chia:store1:rootHash1/resourceKey1';
        const udi = Udi.fromUrn(urn);
        expect(udi.chainName).to.equal('chia');
        expect(udi.storeId).to.equal('store1');
        expect(udi.rootHash).to.equal('rootHash1');
        expect(udi.resourceKey).to.equal('resourceKey1');
    });

    it('should throw an error for an invalid URN namespace', () => {
        const urn = 'urn:invalid:chia:store1:rootHash1/resourceKey1';
        expect(() => Udi.fromUrn(urn)).to.throw('Invalid namespace: invalid');
    });

    it('should convert a Udi to a URN string', () => {
        const udi = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        const urn = udi.toUrn();
        expect(urn).to.equal('urn:dig:chia:store1:rootHash1/resourceKey1');
    });

    it('should correctly compare two Udi instances using equals', () => {
        const udi1 = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        const udi2 = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        const udi3 = new Udi('chia', 'store2', 'rootHash1', 'resourceKey1');
        expect(udi1.equals(udi2)).to.be.true;
        expect(udi1.equals(udi3)).to.be.false;
    });

    it('should convert a Udi to a string using toString', () => {
        const udi = new Udi('chia', 'store1', 'rootHash1', 'resourceKey1');
        const str = udi.toString();
        expect(str).to.equal('urn:dig:chia:store1:rootHash1/resourceKey1');
    });
});